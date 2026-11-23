/** Console policy document detail (/admin/policies/:documentId). Owner: orders_engineer (compliance admin UI). */
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useParams } from "wouter";
import { DocumentImportButton } from "@/lib/docconvert";
import { useTRPC } from "@/lib/trpc";
import { Badge, Breadcrumbs, Button, Callout, Card, Checkbox, ConfirmDialog, DataTable, DateTime, Dialog, Field, FilterBar, Input, KeyValueList, LoadMore, PageHeader, Select, Textarea } from "@/ui";
import { PolicyEnforcementCard } from "../policyUpdates/PolicyEnforcementCards";
import { PolicyNoticeCard } from "../policyUpdates/PolicyNoticeCard";
import { SafePolicyText } from "../shared";
import { QueryState, useGuardedAction } from "./common";
import { ACCEPTANCE_METHOD_LABELS, AUDIENCE_LABELS, FORMAT_LABELS, ULID, acceptanceCounts, fromLocalInput, shortHash, toLocalInput, type PolicyAcceptance, type PolicyAudience, type PolicyDocumentDetail, type PolicyFormat, type PolicyVersion } from "./model";
import { AUDIENCE_OPTIONS, FORMAT_OPTIONS } from "./PoliciesAdminPage";

const REASON = "Managing policies needs verification.";

export default function PolicyDetailPage() {
  const { documentId = "" } = useParams<{ documentId: string }>();
  const trpc = useTRPC();
  const detail = useQuery(trpc.compliance.policies.admin.getDocument.queryOptions({ documentPublicId: documentId }, { enabled: ULID.test(documentId) }));
  const [editing, setEditing] = useState(false);
  const [draftEditor, setDraftEditor] = useState<PolicyVersion | "new" | null>(null);
  const [preview, setPreview] = useState<PolicyVersion | null>(null);
  const [publishing, setPublishing] = useState<PolicyVersion | null>(null);
  const [deleting, setDeleting] = useState<PolicyVersion | null>(null);
  const title = detail.data?.document.title ?? "Policy";
  const header = (
    <PageHeader
      title={title}
      breadcrumbs={<Breadcrumbs items={[{ label: "Policies", href: "/admin/policies" }, { label: title }]} />}
      actions={
        detail.data ? (
          <>
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit settings
            </Button>
            <Button leadingIcon={<Plus aria-hidden />} onClick={() => setDraftEditor("new")}>
              New draft version
            </Button>
          </>
        ) : undefined
      }
    />
  );
  if (!ULID.test(documentId))
    return (
      <>
        {header}
        <Callout tone="danger">This policy link is not valid.</Callout>
      </>
    );
  return (
    <QueryState header={header} query={detail}>
      {() => {
        const data = detail.data as PolicyDocumentDetail;
        const doc = data.document;
        return (
          <div className="flex flex-col gap-6">
            <Card title="Settings">
              <KeyValueList
                items={[
                  { label: "Address name", value: <span className="break-all">{doc.slug}</span> },
                  { label: "Audience", value: AUDIENCE_LABELS[doc.audience] },
                  { label: "Acceptance", value: doc.requiresAcceptance ? (doc.requiresTypedSignature ? "Required, with typed signature" : "Required") : "Informational only" },
                  { label: "Status", value: <Badge tone={doc.active ? "success" : "neutral"}>{doc.active ? "Active" : "Retired"}</Badge> },
                  { label: "Last updated", value: <DateTime value={doc.updatedAt} /> },
                ]}
              />
            </Card>
            <Card title="Versions" description="Published versions are permanent. Drafts can be edited, previewed, published or deleted.">
              <DataTable<PolicyVersion>
                caption={`Versions of ${doc.title}`}
                rows={data.versions}
                rowKey={(v) => v.versionPublicId}
                columns={[
                  { key: "version", header: "Version", primary: true, cell: (v) => `v${v.versionNumber} · ${v.versionLabel}` },
                  { key: "status", header: "Status", cell: (v) => <Badge tone={v.status === "published" ? "success" : "neutral"}>{v.status === "published" ? "Published" : "Draft"}</Badge> },
                  { key: "effective", header: "Effective", cell: (v) => <DateTime value={v.effectiveAt} format="date" /> },
                  { key: "published", header: "Published", hideOnMobile: true, cell: (v) => <DateTime value={v.publishedAt} /> },
                  { key: "hash", header: "Content hash", hideOnMobile: true, cell: (v) => <code className="text-sm break-all" title={v.contentHash}>{shortHash(v.contentHash)}</code> },
                ]}
                rowActions={(v) => (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setPreview(v)}>
                      Preview{" "}<span className="sr-only">version {v.versionNumber}</span>
                    </Button>
                    {v.status === "draft" ? (
                      <>
                        <Button size="sm" variant="secondary" onClick={() => setDraftEditor(v)}>
                          Edit{" "}<span className="sr-only">version {v.versionNumber}</span>
                        </Button>
                        <Button size="sm" onClick={() => setPublishing(v)}>
                          Publish{" "}<span className="sr-only">version {v.versionNumber}</span>
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => setDeleting(v)}>
                          Delete{" "}<span className="sr-only">draft version {v.versionNumber}</span>
                        </Button>
                      </>
                    ) : null}
                  </div>
                )}
                empty={<p className="text-body">No versions yet.</p>}
              />
            </Card>
            {doc.requiresAcceptance ? (
              <>
                <PolicyNoticeCard documentPublicId={doc.documentPublicId} />
                <PolicyEnforcementCard documentPublicId={doc.documentPublicId} />
              </>
            ) : null}
            <AcceptanceEvidence documentPublicId={doc.documentPublicId} versions={data.versions.filter((v) => v.status === "published")} requiresAcceptance={doc.requiresAcceptance} />
            {editing ? <SettingsDialog document={doc} onClose={() => setEditing(false)} /> : null}
            {draftEditor ? <DraftDialog documentPublicId={doc.documentPublicId} version={draftEditor === "new" ? null : draftEditor} latest={data.versions[0] ?? null} onClose={() => setDraftEditor(null)} /> : null}
            {preview ? (
              <Dialog open size="lg" onOpenChange={(open) => (open ? undefined : setPreview(null))} title={`${doc.title} — v${preview.versionNumber} (${preview.versionLabel})`} description={preview.changeSummary ?? undefined}>
                <SafePolicyText bodyText={preview.bodyText} format={preview.contentFormat} />
              </Dialog>
            ) : null}
            {publishing ? <PublishDialog version={publishing} onClose={() => setPublishing(null)} /> : null}
            {deleting ? <DeleteDraftDialog version={deleting} onClose={() => setDeleting(null)} /> : null}
          </div>
        );
      }}
    </QueryState>
  );
}

function SettingsDialog({ document: doc, onClose }: { document: PolicyDocumentDetail["document"]; onClose: () => void }) {
  const trpc = useTRPC();
  const guarded = useGuardedAction();
  const update = useMutation(trpc.compliance.policies.admin.updateDocument.mutationOptions());
  const [values, setValues] = useState({ title: doc.title, audience: doc.audience, requiresAcceptance: doc.requiresAcceptance, requiresTypedSignature: doc.requiresTypedSignature, active: doc.active });
  const [error, setError] = useState<string | null>(null);
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (values.title.trim().length < 2) return setError("Enter a title of at least 2 characters.");
    setError(null);
    const result = await guarded(
      () => update.mutateAsync({ documentPublicId: doc.documentPublicId, expectedVersion: doc.version, ...values, title: values.title.trim(), requiresTypedSignature: values.requiresAcceptance && values.requiresTypedSignature }),
      { reason: REASON, success: "Policy settings saved" },
    );
    if (result.ok) onClose();
    else setError(result.error);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title="Policy settings"
      footer={
        <Button loading={update.isPending} onClick={() => void submit()}>
          Save settings
        </Button>
      }
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
        <Field label="Title" required>
          <Input value={values.title} onChange={(event) => setValues((c) => ({ ...c, title: event.target.value }))} maxLength={160} />
        </Field>
        <Field label="Audience">
          <Select options={AUDIENCE_OPTIONS} value={values.audience} onChange={(event) => setValues((c) => ({ ...c, audience: event.target.value as PolicyAudience }))} />
        </Field>
        <Checkbox label="Acceptance required" checked={values.requiresAcceptance} onCheckedChange={(checked) => setValues((c) => ({ ...c, requiresAcceptance: checked }))} />
        {values.requiresAcceptance ? <Checkbox label="Require a typed signature" checked={values.requiresTypedSignature} onCheckedChange={(checked) => setValues((c) => ({ ...c, requiresTypedSignature: checked }))} /> : null}
        <Checkbox label="Active" description="Retired policies are no longer shown or required." checked={values.active} onCheckedChange={(checked) => setValues((c) => ({ ...c, active: checked }))} />
      </form>
    </Dialog>
  );
}

function DraftDialog({ documentPublicId, version, latest, onClose }: { documentPublicId: string; version: PolicyVersion | null; latest: PolicyVersion | null; onClose: () => void }) {
  const trpc = useTRPC();
  const guarded = useGuardedAction();
  const create = useMutation(trpc.compliance.policies.admin.createDraftVersion.mutationOptions());
  const update = useMutation(trpc.compliance.policies.admin.updateDraftVersion.mutationOptions());
  const source = version ?? latest;
  const [values, setValues] = useState({
    versionLabel: version?.versionLabel ?? "",
    contentFormat: (source?.contentFormat ?? "safe_markdown") as PolicyFormat,
    bodyText: source?.bodyText ?? "",
    changeSummary: version?.changeSummary ?? "",
    effectiveAt: version ? toLocalInput(version.effectiveAt) : "",
  });
  const [error, setError] = useState<string | null>(null);
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!values.versionLabel.trim()) return setError("Enter a version label such as 2.0.");
    if (values.bodyText.trim().length < 10) return setError("The policy text must be at least 10 characters.");
    const effective = fromLocalInput(values.effectiveAt);
    if (values.effectiveAt && !effective) return setError("Enter a valid effective date and time.");
    setError(null);
    const common = { versionLabel: values.versionLabel.trim(), contentFormat: values.contentFormat, bodyText: values.bodyText, changeSummary: values.changeSummary.trim() || undefined };
    const result = await guarded(
      () =>
        version
          ? update.mutateAsync({ versionPublicId: version.versionPublicId, ...common, effectiveAt: effective ?? new Date(version.effectiveAt) })
          : create.mutateAsync({ documentPublicId, ...common, effectiveAt: effective ?? undefined }),
      { reason: REASON, success: version ? "Draft saved" : "Draft version created" },
    );
    if (result.ok) onClose();
    else setError(result.error);
  };
  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={version ? `Edit draft v${version.versionNumber}` : "New draft version"}
      description={version ? undefined : latest ? `Starts from v${latest.versionNumber}. Customers keep seeing the published version until you publish this draft.` : undefined}
      footer={
        <Button loading={create.isPending || update.isPending} onClick={() => void submit()}>
          Save draft
        </Button>
      }
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Version label" required>
            <Input value={values.versionLabel} onChange={(event) => setValues((c) => ({ ...c, versionLabel: event.target.value }))} maxLength={32} />
          </Field>
          <Field label="Format">
            <Select options={FORMAT_OPTIONS} value={values.contentFormat} onChange={(event) => setValues((c) => ({ ...c, contentFormat: event.target.value as PolicyFormat }))} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <DocumentImportButton
            label="Import document (.docx, .md, .pdf)"
            disabled={create.isPending || update.isPending}
            onImport={(imported) =>
              setValues((current) => ({
                ...current,
                contentFormat: imported.sourceKind === "pdf" ? "plain_text" : "safe_markdown",
                bodyText: imported.sourceKind === "pdf" ? imported.plainText : imported.markdown,
              }))
            }
          />
        </div>
        <Field label="Policy text" required hint={`${FORMAT_LABELS[values.contentFormat]}. HTML and links are never rendered. Imported files fill this draft for review and are never published automatically.`}>
          <Textarea value={values.bodyText} onChange={(event) => setValues((c) => ({ ...c, bodyText: event.target.value }))} rows={12} />
        </Field>
        <Field label="Change summary" hint="Optional. What changed and why.">
          <Input value={values.changeSummary} onChange={(event) => setValues((c) => ({ ...c, changeSummary: event.target.value }))} maxLength={500} />
        </Field>
        <Field label="Planned effective date" hint="Optional, in your local time. You confirm the effective date when publishing.">
          <Input type="datetime-local" value={values.effectiveAt} onChange={(event) => setValues((c) => ({ ...c, effectiveAt: event.target.value }))} />
        </Field>
      </form>
    </Dialog>
  );
}

function PublishDialog({ version, onClose }: { version: PolicyVersion; onClose: () => void }) {
  const trpc = useTRPC();
  const guarded = useGuardedAction();
  const publish = useMutation(trpc.compliance.policies.admin.publishVersion.mutationOptions());
  const [effectiveAt, setEffectiveAt] = useState(toLocalInput(version.effectiveAt));
  const [error, setError] = useState<string | null>(null);
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={`Publish v${version.versionNumber} (${version.versionLabel})`}
      description="Published text can never be changed. If acceptance is required, everyone in the audience will be asked to accept this version."
      confirmLabel="Publish version"
      confirmText={version.versionLabel}
      onConfirm={async () => {
        const date = fromLocalInput(effectiveAt);
        if (effectiveAt && !date) {
          setError("Enter a valid effective date and time.");
          throw new Error("invalid");
        }
        setError(null);
        const result = await guarded(() => publish.mutateAsync({ versionPublicId: version.versionPublicId, effectiveAt: date ?? undefined }), { reason: REASON, success: "Version published" });
        if (!result.ok) {
          setError(result.error);
          throw new Error("failed");
        }
      }}
    >
      <div className="flex flex-col gap-3">
        {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
        <Field label="Effective date" hint="Your local time. Leave as is to keep the planned date.">
          <Input type="datetime-local" value={effectiveAt} onChange={(event) => setEffectiveAt(event.target.value)} />
        </Field>
      </div>
    </ConfirmDialog>
  );
}

function DeleteDraftDialog({ version, onClose }: { version: PolicyVersion; onClose: () => void }) {
  const trpc = useTRPC();
  const guarded = useGuardedAction();
  const remove = useMutation(trpc.compliance.policies.admin.deleteDraftVersion.mutationOptions());
  const [error, setError] = useState<string | null>(null);
  return (
    <ConfirmDialog
      open
      destructive
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={`Delete draft v${version.versionNumber}?`}
      description="The draft text is removed. Published versions are not affected."
      confirmLabel="Delete draft"
      onConfirm={async () => {
        const result = await guarded(() => remove.mutateAsync({ versionPublicId: version.versionPublicId }), { reason: REASON, success: "Draft deleted" });
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

function AcceptanceEvidence({ documentPublicId, versions, requiresAcceptance }: { documentPublicId: string; versions: PolicyVersion[]; requiresAcceptance: boolean }) {
  const trpc = useTRPC();
  const [versionPublicId, setVersionPublicId] = useState("");
  const [userInput, setUserInput] = useState("");
  const [userPublicId, setUserPublicId] = useState("");
  const [userError, setUserError] = useState<string | null>(null);
  const list = useInfiniteQuery(
    trpc.compliance.policies.admin.listAcceptances.infiniteQueryOptions(
      { documentPublicId, versionPublicId: versionPublicId || undefined, userPublicId: userPublicId || undefined, limit: 50 },
      { getNextPageParam: (page) => page.nextCursor ?? undefined },
    ),
  );
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  const counts = acceptanceCounts(rows);
  const complete = !list.hasNextPage;
  const applyUser = (value: string) => {
    const trimmed = value.trim();
    if (trimmed && !ULID.test(trimmed)) return setUserError("A customer ID is 26 characters, e.g. from the customer record.");
    setUserError(null);
    setUserPublicId(trimmed);
  };
  return (
    <Card title="Acceptance evidence" description={requiresAcceptance ? "Each record ties a person to the exact version and content hash they accepted." : "This policy is informational; acceptances appear only if it was previously required."}>
      <div className="flex flex-col gap-4">
        <FilterBar
          search={userInput}
          onSearchChange={setUserInput}
          onSearchSubmit={applyUser}
          searchLabel="Customer ID"
          searchPlaceholder="26-character customer ID"
          activeCount={(versionPublicId ? 1 : 0) + (userPublicId ? 1 : 0)}
          onReset={() => {
            setVersionPublicId("");
            setUserInput("");
            setUserPublicId("");
            setUserError(null);
          }}
        >
          <Field label="Version">
            <Select options={versions.map((v) => ({ value: v.versionPublicId, label: `v${v.versionNumber} · ${v.versionLabel}` }))} placeholder="All versions" value={versionPublicId} onChange={(event) => setVersionPublicId(event.target.value)} />
          </Field>
        </FilterBar>
        {userError ? <Callout tone="danger" live="assertive">{userError}</Callout> : null}
        <section aria-labelledby="acceptance-stats" className="flex flex-col gap-2">
          <h3 id="acceptance-stats" className="text-sm font-semibold text-ink">
            Statistics
          </h3>
          {list.isPending ? null : counts.length === 0 ? (
            <p className="text-sm text-muted">No acceptances match these filters.</p>
          ) : (
            <>
              <ul className="flex flex-wrap gap-2">
                {counts.map((c) => (
                  <li key={c.versionPublicId}>
                    <Badge tone="info">
                      v{c.versionNumber} · {c.versionLabel}: {complete ? c.count : `${c.count}+`} accepted{c.typed ? `, ${c.typed} signed` : ""}
                    </Badge>
                  </li>
                ))}
              </ul>
              <p className="text-sm text-muted">{complete ? "Counts include every matching record." : "Counts cover the records loaded so far. Load more for a complete count."}</p>
            </>
          )}
        </section>
        <DataTable<PolicyAcceptance>
          caption="Acceptance records"
          rows={list.data ? rows : undefined}
          loading={list.isPending}
          error={list.error}
          onRetry={() => void list.refetch()}
          rowKey={(row) => row.acceptancePublicId}
          columns={[
            { key: "accepted", header: "Accepted", primary: true, cell: (row) => <DateTime value={row.acceptedAt} /> },
            {
              key: "user",
              header: "Customer",
              cell: (row) => (
                <Link href={`/admin/customers/${row.userPublicId}`} className="break-all text-action underline-offset-2 hover:underline">
                  {row.userPublicId}
                </Link>
              ),
            },
            { key: "version", header: "Version", cell: (row) => `v${row.versionNumber} · ${row.versionLabel}` },
            { key: "method", header: "Method", cell: (row) => ACCEPTANCE_METHOD_LABELS[row.method] + (row.hasTypedSignature ? " (signature on file)" : "") },
            { key: "hash", header: "Content hash", hideOnMobile: true, cell: (row) => <code className="text-sm break-all" title={row.versionContentHash}>{shortHash(row.versionContentHash)}</code> },
            {
              key: "context",
              header: "Context",
              hideOnMobile: true,
              cell: (row) => (
                <span className="flex flex-col text-sm">
                  {row.orderPublicId ? (
                    <Link href={`/admin/orders/${row.orderPublicId}`} className="text-action underline-offset-2 hover:underline">
                      Order
                    </Link>
                  ) : null}
                  <span className="break-all text-muted">Request {row.requestId}</span>
                  {row.origin === "import" ? <span className="text-muted">Imported</span> : null}
                </span>
              ),
            },
          ]}
          empty={<p className="text-body">No acceptance records yet.</p>}
        />
        {list.data ? <LoadMore hasMore={Boolean(list.hasNextPage)} loading={list.isFetchingNextPage} onLoadMore={() => void list.fetchNextPage()} summary={`Showing ${rows.length} records`} /> : null}
      </div>
    </Card>
  );
}
