/**
 * Console → Knowledge base (`/admin/knowledge`). Owner: platform engineer (admin half of package F, by
 * agreement with engagement_engineer). Articles, categories, insights and settings. The server re-checks
 * `knowledge.manage` / `platform.settings.manage` on every call; hiding controls here is UX only.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, BookOpen, FolderPlus, Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import type {
  KnowledgeArticleState,
  KnowledgeArticleSummaryView,
  KnowledgeAudience,
  KnowledgeCategoryView,
  KnowledgeInsightsView,
  KnowledgeSettingsView,
  KnowledgeStatusView,
} from "@server/modules/knowledge/types";
import { errorMessage, useTRPC } from "@/lib/trpc";
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  DataTable,
  DateTime,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  FilterBar,
  IconButton,
  Input,
  PageHeader,
  Select,
  Skeleton,
  StatCard,
  StatGrid,
  Switch,
  Tabs,
  Textarea,
  buttonClasses,
  useStepUp,
  StepUpCancelledError,
  useToast,
  type Column,
  type Tone,
} from "@/ui";

export const STATE_META: Record<KnowledgeArticleState, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" },
  published: { label: "Published", tone: "success" },
  archived: { label: "Archived", tone: "warning" },
};
export const AUDIENCE_LABEL: Record<KnowledgeAudience, string> = { customers: "Customers", staff: "Staff only" };
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

/** Flattens the one-level category tree into select options ("Parent › Child"). */
export function categoryOptions(categories: readonly KnowledgeCategoryView[]): { value: string; label: string }[] {
  return categories.flatMap((c) => [{ value: c.publicId, label: c.title }, ...c.children.map((child) => ({ value: child.publicId, label: `${c.title} › ${child.title}` }))]);
}

/** Runs a mutation, toasts the outcome, and returns undefined on failure. */
function useRun() {
  const toast = useToast();
  return async function run<T>(action: () => Promise<T>, success: string, failure: string): Promise<T | undefined> {
    try {
      const result = await action();
      toast.show({ tone: "success", title: success });
      return result;
    } catch (error) {
      toast.show({ tone: "danger", title: failure, description: errorMessage(error) });
      return undefined;
    }
  };
}

/* ------------------------------------------------------------------ articles */

interface ArticleFilters {
  query: string;
  state: "" | KnowledgeArticleState;
  audience: "" | KnowledgeAudience;
  categoryPublicId: string;
  tag: string;
}
const NO_FILTERS: ArticleFilters = { query: "", state: "", audience: "", categoryPublicId: "", tag: "" };

function ArticlesTab({ categories }: { categories: readonly KnowledgeCategoryView[] }) {
  const trpc = useTRPC();
  const client = useQueryClient();
  const run = useRun();
  const [draft, setDraft] = useState<ArticleFilters>(NO_FILTERS);
  const [filters, setFilters] = useState<ArticleFilters>(NO_FILTERS);
  const [pages, setPages] = useState<(string | undefined)[]>([undefined]);
  const input = {
    ...(filters.query.trim() ? { query: filters.query.trim() } : {}),
    ...(filters.state ? { state: filters.state } : {}),
    ...(filters.audience ? { audience: filters.audience } : {}),
    ...(filters.categoryPublicId ? { categoryPublicId: filters.categoryPublicId } : {}),
    ...(filters.tag.trim() ? { tag: filters.tag.trim().toLowerCase() } : {}),
    limit: 25,
  };
  const cursor = pages[pages.length - 1];
  const list = useQuery(trpc.knowledge.admin.articles.list.queryOptions({ ...input, ...(cursor ? { cursor } : {}) }));
  const setState = useMutation(trpc.knowledge.admin.articles.setState.mutationOptions());
  const data = list.data as { items: KnowledgeArticleSummaryView[]; nextCursor: string | null } | undefined;
  const active = Object.entries(filters).filter(([k, v]) => k !== "query" && v !== "").length;

  async function changeState(article: KnowledgeArticleSummaryView, state: KnowledgeArticleState) {
    const verb = state === "published" ? "published" : state === "archived" ? "archived" : "moved to drafts";
    await run(() => setState.mutateAsync({ publicId: article.publicId, expectedVersion: article.version, state }), `“${article.title}” ${verb}`, "The article was not changed");
    await client.invalidateQueries({ queryKey: trpc.knowledge.admin.articles.list.queryKey() });
  }

  const columns: Column<KnowledgeArticleSummaryView>[] = [
    {
      key: "title",
      header: "Article",
      primary: true,
      cell: (a) => (
        <span className="min-w-0 break-words">
          <Link href={`/admin/knowledge/${a.publicId}`} className="font-medium text-ink underline-offset-2 hover:underline">
            {a.title}
          </Link>
          <span className="block text-xs text-body">/{a.slug}</span>
        </span>
      ),
    },
    { key: "state", header: "State", cell: (a) => <Badge tone={STATE_META[a.state].tone}>{STATE_META[a.state].label}</Badge> },
    { key: "audience", header: "Audience", cell: (a) => AUDIENCE_LABEL[a.audience] },
    { key: "category", header: "Category", cell: (a) => a.categoryTitle ?? "Uncategorised" },
    { key: "feedback", header: "Helpful", align: "end", cell: (a) => `${a.helpfulYesCount} yes · ${a.helpfulNoCount} no` },
    { key: "updated", header: "Updated", cell: (a) => <DateTime value={a.updatedAt} format="date" /> },
  ];

  const apply = (next: ArticleFilters) => {
    setFilters(next);
    setPages([undefined]);
  };

  return (
    <div className="grid gap-4">
      <FilterBar
        search={draft.query}
        onSearchChange={(query) => setDraft({ ...draft, query })}
        onSearchSubmit={(query) => apply({ ...draft, query })}
        searchLabel="Search articles"
        activeCount={active}
        onReset={() => {
          setDraft(NO_FILTERS);
          apply(NO_FILTERS);
        }}
      >
        <Field label="State">
          <Select
            value={draft.state}
            options={[{ value: "", label: "Any state" }, ...Object.entries(STATE_META).map(([value, m]) => ({ value, label: m.label }))]}
            onChange={(e) => {
              const next = { ...draft, state: e.target.value as ArticleFilters["state"] };
              setDraft(next);
              apply(next);
            }}
          />
        </Field>
        <Field label="Audience">
          <Select
            value={draft.audience}
            options={[{ value: "", label: "Any audience" }, ...Object.entries(AUDIENCE_LABEL).map(([value, label]) => ({ value, label }))]}
            onChange={(e) => {
              const next = { ...draft, audience: e.target.value as ArticleFilters["audience"] };
              setDraft(next);
              apply(next);
            }}
          />
        </Field>
        <Field label="Category">
          <Select
            value={draft.categoryPublicId}
            options={[{ value: "", label: "Any category" }, ...categoryOptions(categories)]}
            onChange={(e) => {
              const next = { ...draft, categoryPublicId: e.target.value };
              setDraft(next);
              apply(next);
            }}
          />
        </Field>
        <Field label="Tag">
          <Input value={draft.tag} maxLength={40} autoComplete="off" spellCheck={false} onChange={(e) => setDraft({ ...draft, tag: e.target.value })} onBlur={() => apply(draft)} />
        </Field>
      </FilterBar>
      <p className="sr-only" role="status" aria-live="polite">
        {data ? `${data.items.length} ${data.items.length === 1 ? "article" : "articles"} shown` : ""}
      </p>
      {data && data.items.length === 0 && !list.isFetching ? (
        active || filters.query ? (
          <EmptyState variant="filtered" title="No articles match" onClearFilters={() => { setDraft(NO_FILTERS); apply(NO_FILTERS); }} />
        ) : (
          <EmptyState
            variant="first-use"
            icon={BookOpen}
            title="No articles yet"
            description="Write the first help article. It starts as a draft."
            action={
              <Link href="/admin/knowledge/new" className={buttonClasses("primary", "md")}>
                New article
              </Link>
            }
          />
        )
      ) : (
        <DataTable
          caption="Knowledge base articles"
          columns={columns}
          rows={data?.items ?? []}
          rowKey={(a) => a.publicId}
          loading={list.isPending}
          error={list.error}
          onRetry={() => void list.refetch()}
          rowActions={(a) => (
            <div className="flex flex-wrap gap-1">
              {a.state !== "published" ? (
                <Button size="sm" variant="secondary" aria-label={`Publish ${a.title}`} onClick={() => void changeState(a, "published")}>
                  Publish
                </Button>
              ) : (
                <Button size="sm" variant="secondary" aria-label={`Unpublish ${a.title}`} onClick={() => void changeState(a, "draft")}>
                  Unpublish
                </Button>
              )}
              {a.state !== "archived" ? (
                <Button size="sm" variant="ghost" aria-label={`Archive ${a.title}`} onClick={() => void changeState(a, "archived")}>
                  Archive
                </Button>
              ) : null}
            </div>
          )}
        />
      )}
      <div className="flex flex-wrap gap-2">
        {pages.length > 1 ? (
          <Button variant="ghost" size="sm" onClick={() => setPages((p) => p.slice(0, -1))}>
            Previous page
          </Button>
        ) : null}
        {data?.nextCursor ? (
          <Button variant="secondary" size="sm" loading={list.isFetching} onClick={() => setPages((p) => [...p, data.nextCursor ?? undefined])}>
            Next page
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ categories */

interface CategoryDraft {
  publicId?: string;
  version?: number;
  parentPublicId: string;
  title: string;
  slug: string;
  description: string;
}

export function moveItem<T>(items: readonly T[], index: number, delta: -1 | 1): T[] {
  const next = [...items];
  const target = index + delta;
  if (target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

function CategoriesTab({ categories, onChanged, includeArchived, onIncludeArchived }: { categories: readonly KnowledgeCategoryView[]; onChanged: () => Promise<void>; includeArchived: boolean; onIncludeArchived: (v: boolean) => void }) {
  const trpc = useTRPC();
  const run = useRun();
  const create = useMutation(trpc.knowledge.admin.categories.create.mutationOptions());
  const update = useMutation(trpc.knowledge.admin.categories.update.mutationOptions());
  const archive = useMutation(trpc.knowledge.admin.categories.archive.mutationOptions());
  const reorder = useMutation(trpc.knowledge.admin.categories.reorder.mutationOptions());
  const [editing, setEditing] = useState<CategoryDraft | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [errors, setErrors] = useState<{ title?: string; slug?: string }>({});

  async function move(siblings: readonly KnowledgeCategoryView[], index: number, delta: -1 | 1, parentPublicId: string | null) {
    const ordered = moveItem(siblings, index, delta);
    const moved = siblings[index]!;
    const ok = await run(() => reorder.mutateAsync({ parentPublicId, orderedPublicIds: ordered.map((c) => c.publicId) }), "Order saved", "The order was not saved");
    if (ok) setAnnouncement(`${moved.title} moved to position ${index + delta + 1} of ${siblings.length}`);
    await onChanged();
  }

  async function save() {
    if (!editing) return;
    const next: typeof errors = {};
    if (editing.title.trim().length < 2) next.title = "Enter a title of at least 2 characters.";
    if (!SLUG.test(editing.slug)) next.slug = "Use lowercase letters, numbers and single hyphens.";
    setErrors(next);
    if (next.title || next.slug) return;
    const common = { title: editing.title.trim(), slug: editing.slug, description: editing.description.trim() || null, parentPublicId: editing.parentPublicId || null };
    const ok = editing.publicId
      ? await run(() => update.mutateAsync({ publicId: editing.publicId!, expectedVersion: editing.version!, ...common }), "Category saved", "The category was not saved")
      : await run(() => create.mutateAsync(common), "Category created", "The category was not created");
    if (ok) setEditing(null);
    await onChanged();
  }

  const renderList = (items: readonly KnowledgeCategoryView[], parentPublicId: string | null, level: number) => (
    <ol className={level === 0 ? "divide-y divide-line" : "mt-2 ml-4 border-l border-line pl-3"} aria-label={level === 0 ? "Top-level categories" : undefined}>
      {items.map((c, index) => (
        <li key={c.publicId} className="py-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="font-medium break-words text-ink">
                {c.title} {c.archivedAt ? <Badge tone="warning">Archived</Badge> : null}
              </p>
              <p className="text-sm text-body">
                /{c.slug} · {c.publishedArticleCount} published
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <IconButton label={`Move ${c.title} up`} icon={<ArrowUp className="size-4" aria-hidden />} size="sm" variant="ghost" disabled={index === 0 || reorder.isPending} onClick={() => void move(items, index, -1, parentPublicId)} />
              <IconButton label={`Move ${c.title} down`} icon={<ArrowDown className="size-4" aria-hidden />} size="sm" variant="ghost" disabled={index === items.length - 1 || reorder.isPending} onClick={() => void move(items, index, 1, parentPublicId)} />
              <Button size="sm" variant="secondary" aria-label={`Edit ${c.title}`} onClick={() => { setErrors({}); setEditing({ publicId: c.publicId, version: c.version, parentPublicId: c.parentPublicId ?? "", title: c.title, slug: c.slug, description: c.description ?? "" }); }}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`${c.archivedAt ? "Restore" : "Archive"} ${c.title}`}
                onClick={async () => {
                  await run(() => archive.mutateAsync({ publicId: c.publicId, expectedVersion: c.version, archived: !c.archivedAt }), c.archivedAt ? "Category restored" : "Category archived", "The category was not changed");
                  await onChanged();
                }}
              >
                {c.archivedAt ? "Restore" : "Archive"}
              </Button>
            </div>
          </div>
          {c.children.length > 0 ? renderList(c.children, c.publicId, level + 1) : null}
        </li>
      ))}
    </ol>
  );

  return (
    <Card
      title="Categories"
      description="Two levels at most. Use the arrow buttons to change the order customers see."
      actions={
        <Button leadingIcon={<FolderPlus className="size-4" aria-hidden />} onClick={() => { setErrors({}); setEditing({ parentPublicId: "", title: "", slug: "", description: "" }); }}>
          New category
        </Button>
      }
    >
      <div className="mb-3">
        <Checkbox label="Show archived categories" checked={includeArchived} onCheckedChange={onIncludeArchived} />
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      {categories.length === 0 ? <EmptyState size="sm" title="No categories yet" description="Group articles so customers can browse them." /> : renderList(categories, null, 0)}
      {editing ? (
        <Dialog
          open
          onOpenChange={(open) => !open && setEditing(null)}
          title={editing.publicId ? "Edit category" : "New category"}
          footer={
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button loading={create.isPending || update.isPending} onClick={() => void save()}>
                Save
              </Button>
            </div>
          }
        >
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <Field label="Title" required error={errors.title}>
              <Input value={editing.title} maxLength={160} onChange={(e) => setEditing({ ...editing, title: e.target.value, slug: editing.publicId || editing.slug !== slugify(editing.title) ? editing.slug : slugify(e.target.value) })} />
            </Field>
            <Field label="Address" hint="Used in the link, for example /help/category/getting-started." required error={errors.slug}>
              <Input value={editing.slug} maxLength={120} autoComplete="off" spellCheck={false} onChange={(e) => setEditing({ ...editing, slug: e.target.value })} />
            </Field>
            <Field label="Parent category" hint="Leave empty for a top-level category.">
              <Select
                value={editing.parentPublicId}
                options={[{ value: "", label: "None (top level)" }, ...categories.filter((c) => c.publicId !== editing.publicId).map((c) => ({ value: c.publicId, label: c.title }))]}
                onChange={(e) => setEditing({ ...editing, parentPublicId: e.target.value })}
              />
            </Field>
            <Field label="Description">
              <Textarea value={editing.description} maxLength={500} rows={3} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </Field>
          </form>
        </Dialog>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------------ insights */

function InsightsTab() {
  const trpc = useTRPC();
  const insights = useQuery(trpc.knowledge.admin.insights.queryOptions());
  if (insights.isPending) return <div aria-busy="true"><Skeleton lines={6} /></div>;
  if (insights.error) return <ErrorState error={insights.error} onRetry={() => void insights.refetch()} />;
  const data = insights.data as KnowledgeInsightsView;
  const s = data.stats;
  return (
    <div className="grid gap-6">
      <StatGrid label="Knowledge base statistics">
        <StatCard label="Published for customers" value={s.publishedCustomerArticles} />
        <StatCard label="Drafts" value={s.draftArticles} />
        <StatCard label="Views" value={s.totalViews} />
        <StatCard label="Found helpful" value={s.helpfulYesTotal + s.helpfulNoTotal ? `${Math.round((s.helpfulYesTotal / (s.helpfulYesTotal + s.helpfulNoTotal)) * 100)}%` : "–"} hint={`${s.helpfulYesTotal} yes, ${s.helpfulNoTotal} no`} />
      </StatGrid>
      <Card title="Searches with no results" description="Consider writing an article for these.">
        {data.zeroResultSearches.length === 0 ? (
          <p className="text-sm text-body">Every recent search found something.</p>
        ) : (
          <ul className="divide-y divide-line">
            {data.zeroResultSearches.map((t) => (
              <li key={t.term} className="flex justify-between gap-3 py-2 text-sm">
                <span className="min-w-0 break-words text-ink">{t.term}</span>
                <span className="shrink-0 text-body">{t.zeroResultCount} times</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Top searches">
        {data.topSearches.length === 0 ? (
          <p className="text-sm text-body">No searches yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {data.topSearches.map((t) => (
              <li key={t.term} className="flex justify-between gap-3 py-2 text-sm">
                <span className="min-w-0 break-words text-ink">{t.term}</span>
                <span className="shrink-0 text-body">{t.searchCount} searches</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Recent feedback">
        {data.recentFeedback.length === 0 ? (
          <p className="text-sm text-body">No feedback yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {data.recentFeedback.map((f) => (
              <li key={f.publicId} className="py-2 text-sm">
                <p className="flex flex-wrap items-center gap-2">
                  <Badge tone={f.helpful ? "success" : "warning"}>{f.helpful ? "Helpful" : "Not helpful"}</Badge>
                  <Link href={`/admin/knowledge/${f.articlePublicId}`} className="font-medium text-ink underline">
                    {f.articleTitle}
                  </Link>
                  <DateTime value={f.createdAt} format="relative" />
                </p>
                {f.comment ? <p className="mt-1 break-words whitespace-pre-line text-body">{f.comment}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ settings */

function SettingsTab({ status }: { status: KnowledgeStatusView | undefined }) {
  const trpc = useTRPC();
  const client = useQueryClient();
  const stepUp = useStepUp();
  const toast = useToast();
  const settings = useQuery(trpc.knowledge.admin.settings.get.queryOptions());
  const update = useMutation(trpc.knowledge.admin.settings.update.mutationOptions());
  const [retention, setRetention] = useState<string | null>(null);
  const view = settings.data as KnowledgeSettingsView | undefined;
  const canConfigure = status?.canConfigure === true;

  async function change(input: Partial<KnowledgeSettingsView>, success: string) {
    try {
      await stepUp.run(() => update.mutateAsync(input), { reason: "Changing knowledge base settings needs verification." });
      toast.show({ tone: "success", title: success });
    } catch (error) {
      if (error instanceof StepUpCancelledError) return;
      toast.show({ tone: "danger", title: "The setting was not changed", description: errorMessage(error) });
    }
    await client.invalidateQueries({ queryKey: trpc.knowledge.admin.settings.get.queryKey() });
    await client.invalidateQueries({ queryKey: trpc.knowledge.status.queryKey() });
    await client.invalidateQueries({ queryKey: trpc.platform.bootstrap.queryKey() });
  }

  if (settings.isPending) return <div aria-busy="true"><Skeleton lines={3} /></div>;
  if (settings.error || !view) return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;
  const retentionValue = retention ?? String(view.searchLogRetentionDays);
  const retentionNumber = Number(retentionValue);
  const retentionError = Number.isInteger(retentionNumber) && retentionNumber >= 7 && retentionNumber <= 365 ? undefined : "Enter a whole number from 7 to 365.";

  return (
    <Card title="Settings" description={canConfigure ? "Changes need verification and are recorded in the audit log." : "Only administrators can change these settings."}>
      <div className="grid gap-5">
        <Switch label="Show the help centre to customers" description="Customers see published articles at /help. Staff can write articles while this is off." checked={view.enabled} disabled={!canConfigure || update.isPending} onCheckedChange={(enabled) => void change({ enabled }, enabled ? "Help centre turned on" : "Help centre turned off")} />
        <Switch label="Allow comments with feedback" description="Customers can add a short comment when they rate an article." checked={view.allowFeedbackComments} disabled={!canConfigure || update.isPending} onCheckedChange={(allowFeedbackComments) => void change({ allowFeedbackComments }, "Feedback setting saved")} />
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (!retentionError) void change({ searchLogRetentionDays: retentionNumber }, "Retention saved").then(() => setRetention(null));
          }}
        >
          <div className="sm:w-64">
            <Field label="Keep search statistics for (days)" error={retention !== null ? retentionError : undefined}>
              <Input inputMode="numeric" value={retentionValue} disabled={!canConfigure} onChange={(e) => setRetention(e.target.value)} />
            </Field>
          </div>
          <Button type="submit" variant="secondary" disabled={!canConfigure || retention === null || Boolean(retentionError)}>
            Save retention
          </Button>
        </form>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ page */

export default function AdminKnowledgeListPage() {
  const trpc = useTRPC();
  const client = useQueryClient();
  const [tab, setTab] = useState("articles");
  const [includeArchived, setIncludeArchived] = useState(false);
  const status = useQuery(trpc.knowledge.status.queryOptions());
  const categories = useQuery(trpc.knowledge.admin.categories.list.queryOptions({ includeArchived }));
  const statusView = status.data as KnowledgeStatusView | undefined;
  const items = ((categories.data as { items: KnowledgeCategoryView[] } | undefined)?.items ?? []) as KnowledgeCategoryView[];
  const refreshCategories = async () => {
    await client.invalidateQueries({ queryKey: trpc.knowledge.admin.categories.list.queryKey() });
  };

  return (
    <>
      <PageHeader
        title="Knowledge base"
        description="Write and organise help articles for customers and staff."
        actions={
          <Link href="/admin/knowledge/new" className={buttonClasses("primary", "md")}>
            <Plus className="size-4" aria-hidden /> New article
          </Link>
        }
      />
      {statusView && !statusView.enabled ? (
        <Callout tone="warning" className="mb-6" title="Not turned on">
          Customers cannot see the help centre yet. You can write and publish articles now{statusView.canConfigure ? " and turn it on under Settings." : "; an administrator turns it on."}
        </Callout>
      ) : null}
      <Tabs
        label="Knowledge base sections"
        value={tab}
        onValueChange={setTab}
        items={[
          { value: "articles", label: "Articles", content: <ArticlesTab categories={items} /> },
          {
            value: "categories",
            label: "Categories",
            content: categories.isPending ? (
              <div aria-busy="true"><Skeleton lines={4} /></div>
            ) : categories.error ? (
              <ErrorState error={categories.error} onRetry={() => void categories.refetch()} />
            ) : (
              <CategoriesTab categories={items} onChanged={refreshCategories} includeArchived={includeArchived} onIncludeArchived={setIncludeArchived} />
            ),
          },
          { value: "insights", label: "Insights", content: <InsightsTab /> },
          { value: "settings", label: "Settings", content: <SettingsTab status={statusView} /> },
        ]}
      />
    </>
  );
}
