/** /admin/community/settings — switch, forum rules, word filters and categories. Owner: audit_engineer (package M). */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useState, type FormEvent } from "react";
import { errorMessage } from "@/lib/trpc";
import { Badge, Breadcrumbs, Button, Callout, Card, Checkbox, ErrorState, Field, IconButton, Input, PageHeader, Section, Skeleton, StepUpCancelledError, Switch, TagInput, useStepUp, useToast } from "@/ui";
import { useCommunityApi, type CategoryView, type CommunityConfig } from "../api";

const NUMBER_FIELDS: { key: keyof Omit<CommunityConfig, "blockedWords" | "heldWords">; label: string; hint: string; min: number; max: number }[] = [
  { key: "editWindowMinutes", label: "Edit window (minutes)", hint: "How long authors can edit their own post. 0 turns editing off.", min: 0, max: 1440 },
  { key: "maxPostsPerHour", label: "Posts per hour per member", hint: "Applies to every customer. Staff are not limited.", min: 1, max: 200 },
  { key: "newMemberDays", label: "New member period (days)", hint: "Accounts younger than this have the limits below.", min: 0, max: 90 },
  { key: "newMemberDailyPosts", label: "Posts per day for new members", hint: "Further posts are refused until the next day.", min: 1, max: 100 },
  { key: "newMemberReviewPosts", label: "First posts held for review", hint: "A new member's first posts wait for a moderator.", min: 0, max: 20 },
  { key: "autoHideReportCount", label: "Reports before a post is hidden", hint: "Distinct members. A moderator then decides.", min: 1, max: 50 },
];

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/u;

export default function CommunitySettingsPage() {
  const api = useCommunityApi();
  const qc = useQueryClient();
  const toast = useToast();
  const stepUp = useStepUp();
  const settings = useQuery(api.admin.settings.get.queryOptions());
  const setEnabled = useMutation(api.admin.setEnabled.mutationOptions());
  const update = useMutation(api.admin.settings.update.mutationOptions());
  const createCategory = useMutation(api.admin.categories.create.mutationOptions());
  const updateCategory = useMutation(api.admin.categories.update.mutationOptions());
  const reorder = useMutation(api.admin.categories.reorder.mutationOptions());
  const [draft, setDraft] = useState<CommunityConfig | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof CommunityConfig, string>>>({});
  const [cat, setCat] = useState({ name: "", slug: "", description: "", staffOnlyPosting: false });
  const [catError, setCatError] = useState<string | null>(null);

  /** Unsaved edits, else the stored rules. */
  const form = draft ?? settings.data?.config ?? null;

  const refresh = () => qc.invalidateQueries(api.admin.settings.get.pathFilter());
  const fail = (title: string, error: unknown) => {
    if (!(error instanceof StepUpCancelledError)) toast.show({ title, description: errorMessage(error), tone: "danger" });
  };

  const toggle = async (next: boolean) => {
    try {
      await stepUp.run(() => setEnabled.mutateAsync({ enabled: next }), { reason: "Switching the community forum requires a fresh confirmation." });
      toast.show({ title: next ? "Community forum switched on" : "Community forum switched off", tone: "success" });
    } catch (error) {
      fail("Not changed", error);
    } finally {
      await refresh();
      await qc.invalidateQueries();
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    const next: typeof errors = {};
    for (const f of NUMBER_FIELDS) {
      const v = form[f.key];
      if (!Number.isInteger(v) || v < f.min || v > f.max) next[f.key] = `Enter a whole number from ${f.min} to ${f.max}.`;
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    try {
      await stepUp.run(() => update.mutateAsync(form), { reason: "Changing community rules requires a fresh confirmation." });
      toast.show({ title: "Community rules saved", tone: "success" });
      setDraft(null);
      await refresh();
    } catch (error) {
      fail("Not saved", error);
    }
  };

  const addCategory = async (e: FormEvent) => {
    e.preventDefault();
    const slug = cat.slug.trim().toLowerCase();
    if (cat.name.trim().length < 2) return setCatError("Enter a name of at least 2 characters.");
    if (!SLUG.test(slug)) return setCatError("Use lower-case letters, numbers and hyphens for the web address.");
    setCatError(null);
    try {
      await stepUp.run(() => createCategory.mutateAsync({ ...cat, slug, name: cat.name.trim() }), { reason: "Changing categories requires a fresh confirmation." });
      setCat({ name: "", slug: "", description: "", staffOnlyPosting: false });
      toast.show({ title: "Category added", tone: "success" });
      await refresh();
    } catch (error) {
      fail("Not added", error);
    }
  };

  const changeCategory = async (c: CategoryView, patch: { archived?: boolean; staffOnlyPosting?: boolean }) => {
    try {
      await stepUp.run(() => updateCategory.mutateAsync({ categoryPublicId: c.publicId, expectedVersion: c.version, ...patch }), { reason: "Changing categories requires a fresh confirmation." });
      toast.show({ title: patch.archived === undefined ? "Category updated" : patch.archived ? `"${c.name}" archived` : `"${c.name}" restored`, tone: "success" });
    } catch (error) {
      fail("Not changed", error);
    } finally {
      await refresh();
    }
  };

  const move = async (index: number, delta: -1 | 1) => {
    const list = [...(settings.data?.categories ?? [])];
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target]!, list[index]!];
    try {
      await stepUp.run(() => reorder.mutateAsync({ orderedPublicIds: list.map((c) => c.publicId) }), { reason: "Changing categories requires a fresh confirmation." });
      toast.show({ title: `"${list[target]!.name}" moved ${delta < 0 ? "up" : "down"}`, tone: "success" });
    } catch (error) {
      fail("Not moved", error);
    } finally {
      await refresh();
    }
  };

  const header = (
    <PageHeader
      breadcrumbs={<Breadcrumbs items={[{ label: "Console", href: "/admin" }, { label: "Community settings" }]} />}
      title="Community settings"
      description="Switch the member forum on or off, set posting rules and manage categories. Members post under a display name they choose."
    />
  );
  if (settings.isPending) return <>{header}<Skeleton className="h-48" /></>;
  if (settings.isError) return <>{header}<ErrorState error={settings.error} onRetry={() => void settings.refetch()} /></>;
  const data = settings.data;
  const categories = data.categories;

  return (
    <>
      {header}
      <div className="space-y-8">
        <Card title="Community forum" description="When switched off, community pages and navigation disappear for everyone and the server refuses every community request.">
          <Switch label="Community forum switched on" description={data.enabled ? "Members can read and post." : "Off. Nothing is visible to members."} checked={data.enabled} onCheckedChange={(v) => void toggle(v)} disabled={setEnabled.isPending} />
          {data.enabled && categories.filter((c) => !c.archived).length === 0 && (
            <Callout tone="warning" className="mt-4" title="No categories yet">Add at least one category so members can start topics.</Callout>
          )}
        </Card>

        {form && (
          <Section title="Posting rules">
            <form onSubmit={(e) => void save(e)} noValidate className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-2">
                {NUMBER_FIELDS.map((f) => (
                  <Field key={f.key} label={f.label} hint={f.hint} error={errors[f.key]}>
                    <Input type="number" inputMode="numeric" min={f.min} max={f.max} value={Number.isNaN(form[f.key]) ? "" : String(form[f.key])} onChange={(e) => setDraft({ ...form, [f.key]: e.target.value === "" ? Number.NaN : Number(e.target.value) })} />
                  </Field>
                ))}
              </div>
              <TagInput label="Blocked words and phrases" hint="Posts containing these are refused. Whole words only, not case-sensitive. Up to 200." value={form.blockedWords} onValueChange={(v) => setDraft({ ...form, blockedWords: v })} max={200} maxLength={40} />
              <TagInput label="Words that hold a post for review" hint="Posts containing these wait for a moderator. Up to 200." value={form.heldWords} onValueChange={(v) => setDraft({ ...form, heldWords: v })} max={200} maxLength={40} />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" loading={update.isPending}>Save rules</Button>
                <Button type="button" variant="ghost" onClick={() => { setDraft(null); setErrors({}); }}>Undo changes</Button>
              </div>
            </form>
          </Section>
        )}

        <Section title="Categories" description="Archived categories stay readable but accept no new topics, replies or edits.">
          {categories.length === 0 ? (
            <p className="text-sm text-muted">No categories yet.</p>
          ) : (
            <ol className="divide-y divide-line rounded-lg border border-line" aria-label="Categories in display order">
              {categories.map((c, i) => (
                <li key={c.publicId} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-medium break-words">{c.name} {c.archived && <Badge>Archived</Badge>} {c.staffOnlyPosting && <Badge tone="info">Staff posts only</Badge>}</p>
                    <p className="text-sm text-muted break-all">/community/c/{c.slug} · {c.topicCount} topics</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <IconButton icon={<ArrowUp className="size-4" aria-hidden />} label={`Move ${c.name} up`} variant="ghost" disabled={i === 0} onClick={() => void move(i, -1)} />
                    <IconButton icon={<ArrowDown className="size-4" aria-hidden />} label={`Move ${c.name} down`} variant="ghost" disabled={i === categories.length - 1} onClick={() => void move(i, 1)} />
                    <Button size="sm" variant="secondary" onClick={() => void changeCategory(c, { staffOnlyPosting: !c.staffOnlyPosting })}>{c.staffOnlyPosting ? "Let members post" : "Staff posts only"}</Button>
                    <Button size="sm" variant="ghost" onClick={() => void changeCategory(c, { archived: !c.archived })}>{c.archived ? "Restore" : "Archive"}</Button>
                  </div>
                </li>
              ))}
            </ol>
          )}
          <form onSubmit={(e) => void addCategory(e)} noValidate className="mt-6 space-y-4 rounded-lg border border-line p-4" aria-labelledby="add-category-h">
            <h3 id="add-category-h" className="text-base font-semibold">Add a category</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" required>
                <Input value={cat.name} maxLength={80} onChange={(e) => setCat({ ...cat, name: e.target.value })} />
              </Field>
              <Field label="Web address" required hint="Lower-case letters, numbers and hyphens, for example billing-questions." error={catError ?? undefined}>
                <Input value={cat.slug} maxLength={48} autoCapitalize="none" spellCheck={false} onChange={(e) => setCat({ ...cat, slug: e.target.value })} />
              </Field>
            </div>
            <Field label="Description">
              <Input value={cat.description} maxLength={300} onChange={(e) => setCat({ ...cat, description: e.target.value })} />
            </Field>
            <Checkbox label="Only staff can start topics" checked={cat.staffOnlyPosting} onCheckedChange={(v) => setCat({ ...cat, staffOnlyPosting: v === true })} />
            <Button type="submit" loading={createCategory.isPending}>Add category</Button>
          </form>
        </Section>
      </div>
    </>
  );
}
