/** Console intake questionnaires (/admin/intake): builder, scope, versions and publishing. Owner: orders_engineer (compliance admin UI). */
import { useMutation, useQuery } from "@tanstack/react-query";
import { ClipboardList, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import { useTRPC } from "@/lib/trpc";
import { Badge, Button, Callout, Checkbox, ConfirmDialog, DataTable, DateTime, Dialog, EmptyState, Field, Input, PageHeader, Select, Skeleton, Textarea, ErrorState } from "@/ui";
import { QueryState, useCan, useGuardedAction } from "./common";
import { FieldBuilder } from "./FieldBuilder";
import { SCOPE_LABELS, SLUG, blankField, draftsToFields, fieldToDraft, shortHash, type FieldDraft, type IntakeScopeKind, type QuestionnaireDetail, type QuestionnaireSummary } from "./model";

const REASON = "Managing intake questionnaires needs verification.";
const SCOPE_OPTIONS = (Object.keys(SCOPE_LABELS) as IntakeScopeKind[]).map((value) => ({ value, label: SCOPE_LABELS[value] }));

type DialogState = { kind: "create" } | { kind: "settings"; item: QuestionnaireSummary } | { kind: "fields"; item: QuestionnaireSummary } | { kind: "history"; item: QuestionnaireSummary } | { kind: "publish"; item: QuestionnaireSummary } | null;

function scopeText(item: { scopeKind: IntakeScopeKind; scopeRef: string | null }) {
  return item.scopeKind === "default" ? SCOPE_LABELS.default : `${SCOPE_LABELS[item.scopeKind]}: ${item.scopeRef ?? "—"}`;
}

export default function IntakeAdminPage() {
  const trpc = useTRPC();
  const list = useQuery(trpc.compliance.intake.admin.listQuestionnaires.queryOptions());
  const canReview = useCan("intake.review");
  const [dialog, setDialog] = useState<DialogState>(null);
  const header = (
    <PageHeader
      title="Intake questionnaires"
      description="Questions customers answer for their orders. Each order is bound to the questionnaire version published when it was placed; later edits never change past answers."
      actions={
        <>
          {canReview ? (
            <Link href="/admin/intake/submissions" className="inline-flex min-h-11 items-center px-3 text-sm font-medium text-action underline-offset-2 hover:underline">
              Review submissions
            </Link>
          ) : null}
          <Button leadingIcon={<Plus aria-hidden />} onClick={() => setDialog({ kind: "create" })}>
            New questionnaire
          </Button>
        </>
      }
    />
  );
  return (
    <QueryState header={header} query={list}>
      {() => {
        const rows = list.data ?? [];
        return (
          <>
            {rows.length === 0 ? (
              <EmptyState
                icon={ClipboardList}
                title="No questionnaires yet"
                description="Create a questionnaire, choose which orders it applies to, add questions, then publish it."
                action={<Button onClick={() => setDialog({ kind: "create" })}>Create the first questionnaire</Button>}
              />
            ) : (
              <DataTable<QuestionnaireSummary>
                caption="Intake questionnaires"
                rows={rows}
                rowKey={(row) => row.questionnairePublicId}
                columns={[
                  {
                    key: "title",
                    header: "Questionnaire",
                    primary: true,
                    cell: (row) => (
                      <span className="flex min-w-0 flex-col">
                        <span className="font-semibold break-words text-ink">{row.title}</span>
                        <span className="text-sm break-all text-muted">{row.slug}</span>
                      </span>
                    ),
                  },
                  { key: "scope", header: "Applies to", cell: (row) => <span className="break-words">{scopeText(row)}</span> },
                  {
                    key: "published",
                    header: "Published",
                    cell: (row) =>
                      row.currentPublishedVersion ? (
                        <span>
                          v{row.currentPublishedVersion.versionNumber} · {row.currentPublishedVersion.fieldCount} questions
                        </span>
                      ) : (
                        <span className="text-muted">Not published</span>
                      ),
                  },
                  { key: "draft", header: "Draft", cell: (row) => (row.draftVersionPublicId ? <Badge tone="warning">Unpublished changes</Badge> : <span className="text-muted">None</span>) },
                  { key: "active", header: "Status", cell: (row) => <Badge tone={row.active ? "success" : "neutral"}>{row.active ? "Active" : "Inactive"}</Badge> },
                ]}
                rowActions={(row) => (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: "fields", item: row })}>
                      Edit questions{" "}<span className="sr-only">for {row.title}</span>
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "settings", item: row })}>
                      Settings{" "}<span className="sr-only">for {row.title}</span>
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "history", item: row })}>
                      Versions{" "}<span className="sr-only">of {row.title}</span>
                    </Button>
                    {row.draftVersionPublicId ? (
                      <Button size="sm" onClick={() => setDialog({ kind: "publish", item: row })}>
                        Publish{" "}<span className="sr-only">{row.title}</span>
                      </Button>
                    ) : null}
                  </div>
                )}
              />
            )}
            {dialog?.kind === "create" ? <CreateDialog onClose={() => setDialog(null)} /> : null}
            {dialog?.kind === "settings" ? <SettingsDialog item={dialog.item} onClose={() => setDialog(null)} /> : null}
            {dialog?.kind === "fields" ? <FieldsDialog item={dialog.item} onClose={() => setDialog(null)} /> : null}
            {dialog?.kind === "history" ? <HistoryDialog item={dialog.item} onClose={() => setDialog(null)} /> : null}
            {dialog?.kind === "publish" ? <PublishDialog item={dialog.item} onClose={() => setDialog(null)} /> : null}
          </>
        );
      }}
    </QueryState>
  );
}

function ScopeFields({ scopeKind, scopeRef, onChange }: { scopeKind: IntakeScopeKind; scopeRef: string; onChange: (patch: { scopeKind?: IntakeScopeKind; scopeRef?: string }) => void }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Applies to">
        <Select options={SCOPE_OPTIONS} value={scopeKind} onChange={(e) => onChange({ scopeKind: e.target.value as IntakeScopeKind })} />
      </Field>
      {scopeKind === "default" ? null : (
        <Field label={scopeKind === "catalog_item" ? "Product key" : "Workflow key"} required hint="Exactly as shown in the catalog or workflow settings.">
          <Input value={scopeRef} onChange={(e) => onChange({ scopeRef: e.target.value })} maxLength={64} autoComplete="off" spellCheck={false} />
        </Field>
      )}
    </div>
  );
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const trpc = useTRPC();
  const guarded = useGuardedAction();
  const create = useMutation(trpc.compliance.intake.admin.createQuestionnaire.mutationOptions());
  const [values, setValues] = useState({ slug: "", title: "", description: "", scopeKind: "default" as IntakeScopeKind, scopeRef: "" });
  const [fields, setFields] = useState<FieldDraft[]>(() => [blankField()]);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!SLUG.test(values.slug) || values.slug.length < 2 || values.slug.length > 64) return setError("The identifier must be 2–64 lowercase letters, digits and single hyphens.");
    if (values.title.trim().length < 2) return setError("Enter a title of at least 2 characters.");
    if (values.scopeKind !== "default" && !values.scopeRef.trim()) return setError("Enter the product or workflow key this questionnaire applies to.");
    const parsed = draftsToFields(fields);
    if ("error" in parsed) return setError(parsed.error);
    setError(null);
    const result = await guarded(
      () =>
        create.mutateAsync({
          slug: values.slug,
          title: values.title.trim(),
          description: values.description.trim() || undefined,
          scopeKind: values.scopeKind,
          scopeRef: values.scopeKind === "default" ? undefined : values.scopeRef.trim(),
          fields: parsed.fields,
        }),
      { reason: REASON, success: "Questionnaire created as a draft" },
    );
    if (result.ok) onClose();
    else setError(result.error);
  };
  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(open) => (open ? undefined : onClose())}
      title="New questionnaire"
      description="Saved as a draft. Customers see it only after you publish."
      footer={
        <Button loading={create.isPending} onClick={() => void submit()}>
          Create draft
        </Button>
      }
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title" required>
            <Input value={values.title} onChange={(e) => setValues((c) => ({ ...c, title: e.target.value }))} maxLength={160} />
          </Field>
          <Field label="Identifier" required hint="Permanent, e.g. project-intake.">
            <Input value={values.slug} onChange={(e) => setValues((c) => ({ ...c, slug: e.target.value.toLowerCase() }))} maxLength={64} autoComplete="off" spellCheck={false} />
          </Field>
        </div>
        <Field label="Description" hint="Optional. Shown to customers above the questions.">
          <Textarea value={values.description} onChange={(e) => setValues((c) => ({ ...c, description: e.target.value }))} maxLength={1000} rows={2} />
        </Field>
        <ScopeFields scopeKind={values.scopeKind} scopeRef={values.scopeRef} onChange={(patch) => setValues((c) => ({ ...c, ...patch }))} />
        <FieldBuilder fields={fields} onChange={setFields} />
      </form>
    </Dialog>
  );
}

function SettingsDialog({ item, onClose }: { item: QuestionnaireSummary; onClose: () => void }) {
  const trpc = useTRPC();
  const guarded = useGuardedAction();
  const update = useMutation(trpc.compliance.intake.admin.updateQuestionnaire.mutationOptions());
  const [values, setValues] = useState({ title: item.title, description: item.description ?? "", scopeKind: item.scopeKind, scopeRef: item.scopeRef ?? "", active: item.active });
  const [error, setError] = useState<string | null>(null);
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (values.title.trim().length < 2) return setError("Enter a title of at least 2 characters.");
    if (values.scopeKind !== "default" && !values.scopeRef.trim()) return setError("Enter the product or workflow key this questionnaire applies to.");
    setError(null);
    const result = await guarded(
      () =>
        update.mutateAsync({
          questionnairePublicId: item.questionnairePublicId,
          expectedVersion: item.version,
          title: values.title.trim(),
          description: values.description.trim() || null,
          scopeKind: values.scopeKind,
          scopeRef: values.scopeKind === "default" ? null : values.scopeRef.trim(),
          active: values.active,
        }),
      { reason: REASON, success: "Questionnaire settings saved" },
    );
    if (result.ok) onClose();
    else setError(result.error);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={`Settings for ${item.title}`}
      footer={
        <Button loading={update.isPending} onClick={() => void submit()}>
          Save settings
        </Button>
      }
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
        <Field label="Title" required>
          <Input value={values.title} onChange={(e) => setValues((c) => ({ ...c, title: e.target.value }))} maxLength={160} />
        </Field>
        <Field label="Description">
          <Textarea value={values.description} onChange={(e) => setValues((c) => ({ ...c, description: e.target.value }))} maxLength={1000} rows={2} />
        </Field>
        <ScopeFields scopeKind={values.scopeKind} scopeRef={values.scopeRef} onChange={(patch) => setValues((c) => ({ ...c, ...patch }))} />
        <Checkbox label="Active" description="Inactive questionnaires are not attached to new orders." checked={values.active} onCheckedChange={(checked) => setValues((c) => ({ ...c, active: checked }))} />
      </form>
    </Dialog>
  );
}

function useQuestionnaire(id: string) {
  const trpc = useTRPC();
  return useQuery(trpc.compliance.intake.admin.getQuestionnaire.queryOptions({ questionnairePublicId: id }));
}

function FieldsDialog({ item, onClose }: { item: QuestionnaireSummary; onClose: () => void }) {
  const detail = useQuestionnaire(item.questionnairePublicId);
  return (
    <Dialog open size="lg" onOpenChange={(open) => (open ? undefined : onClose())} title={`Questions for ${item.title}`} description="Saving updates the draft. Publish the draft to use it for new orders.">
      {detail.isPending ? <Skeleton lines={6} /> : detail.error ? <ErrorState error={detail.error} onRetry={() => void detail.refetch()} /> : <FieldsEditor item={item} detail={detail.data} onClose={onClose} />}
    </Dialog>
  );
}

function FieldsEditor({ item, detail, onClose }: { item: QuestionnaireSummary; detail: QuestionnaireDetail; onClose: () => void }) {
  const trpc = useTRPC();
  const guarded = useGuardedAction();
  const save = useMutation(trpc.compliance.intake.admin.saveDraftVersion.mutationOptions());
  const draft = detail.versions.find((v) => v.status === "draft");
  const base = draft ?? [...detail.versions].sort((a, b) => b.versionNumber - a.versionNumber)[0];
  const [fields, setFields] = useState<FieldDraft[]>(() => (base?.fields.length ? base.fields.map(fieldToDraft) : [blankField()]));
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const parsed = draftsToFields(fields);
    if ("error" in parsed) return setError(parsed.error);
    setError(null);
    const result = await guarded(() => save.mutateAsync({ questionnairePublicId: item.questionnairePublicId, versionPublicId: draft?.versionPublicId, fields: parsed.fields }), { reason: REASON, success: "Draft questions saved" });
    if (result.ok) onClose();
    else setError(result.error);
  };
  return (
    <div className="flex flex-col gap-4">
      {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
      <p className="text-sm text-muted">{draft ? `Editing draft v${draft.versionNumber}.` : base ? `Starting a new draft from v${base.versionNumber}.` : "Starting a new draft."}</p>
      <FieldBuilder fields={fields} onChange={setFields} />
      <div className="flex justify-end border-t border-line pt-4">
        <Button loading={save.isPending} onClick={() => void submit()}>
          Save draft
        </Button>
      </div>
    </div>
  );
}

function HistoryDialog({ item, onClose }: { item: QuestionnaireSummary; onClose: () => void }) {
  const detail = useQuestionnaire(item.questionnairePublicId);
  return (
    <Dialog open size="lg" onOpenChange={(open) => (open ? undefined : onClose())} title={`Versions of ${item.title}`} description="Published versions are permanent; orders keep the version they were bound to.">
      <DataTable<QuestionnaireDetail["versions"][number]>
        caption={`Versions of ${item.title}`}
        rows={detail.data?.versions}
        loading={detail.isPending}
        error={detail.error}
        onRetry={() => void detail.refetch()}
        rowKey={(v) => v.versionPublicId}
        columns={[
          { key: "version", header: "Version", primary: true, cell: (v) => `v${v.versionNumber}` },
          { key: "status", header: "Status", cell: (v) => <Badge tone={v.status === "published" ? "success" : "neutral"}>{v.status === "published" ? "Published" : "Draft"}</Badge> },
          { key: "fields", header: "Questions", align: "end", cell: (v) => v.fields.length },
          { key: "published", header: "Published", cell: (v) => <DateTime value={v.publishedAt} /> },
          { key: "hash", header: "Schema hash", hideOnMobile: true, cell: (v) => <code className="text-sm break-all" title={v.schemaHash}>{shortHash(v.schemaHash)}</code> },
        ]}
        empty={<p className="text-body">No versions yet.</p>}
      />
    </Dialog>
  );
}

function PublishDialog({ item, onClose }: { item: QuestionnaireSummary; onClose: () => void }) {
  const trpc = useTRPC();
  const guarded = useGuardedAction();
  const publish = useMutation(trpc.compliance.intake.admin.publishVersion.mutationOptions());
  const [error, setError] = useState<string | null>(null);
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={`Publish ${item.title}?`}
      description="New orders in scope will use this version. Existing orders keep their bound version and answers."
      confirmLabel="Publish"
      confirmText={item.slug}
      onConfirm={async () => {
        const versionPublicId = item.draftVersionPublicId;
        if (!versionPublicId) throw new Error("no draft");
        const result = await guarded(() => publish.mutateAsync({ versionPublicId }), { reason: REASON, success: "Questionnaire published" });
        if (!result.ok) {
          setError(result.error);
          throw new Error("failed");
        }
      }}
    >
      {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
    </ConfirmDialog>
  );
}
