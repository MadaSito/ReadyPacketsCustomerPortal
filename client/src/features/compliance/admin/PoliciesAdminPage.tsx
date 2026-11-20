/** Console policy documents (/admin/policies). Owner: orders_engineer (compliance admin UI). Ships empty; no built-in policies. */
import { useMutation, useQuery } from "@tanstack/react-query";
import { FileText, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { useTRPC } from "@/lib/trpc";
import { Badge, Button, Callout, Checkbox, DataTable, DateTime, Dialog, EmptyState, Field, Input, PageHeader, Select, Textarea } from "@/ui";
import { QueryState, useGuardedAction } from "./common";
import { AUDIENCE_LABELS, FORMAT_LABELS, SLUG, fromLocalInput, type PolicyAudience, type PolicyDocumentSummary, type PolicyFormat } from "./model";

export const AUDIENCE_OPTIONS = (Object.keys(AUDIENCE_LABELS) as PolicyAudience[]).map((value) => ({ value, label: AUDIENCE_LABELS[value] }));
export const FORMAT_OPTIONS = (Object.keys(FORMAT_LABELS) as PolicyFormat[]).map((value) => ({ value, label: FORMAT_LABELS[value] }));

export default function PoliciesAdminPage() {
  const trpc = useTRPC();
  const documents = useQuery(trpc.compliance.policies.admin.listDocuments.queryOptions());
  const [creating, setCreating] = useState(false);
  const header = (
    <PageHeader
      title="Policies"
      description="Terms, privacy and other documents customers or staff must read. Publishing a version records its content hash; acceptances are tied to that exact version."
      actions={
        <Button leadingIcon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
          New policy
        </Button>
      }
    />
  );
  return (
    <QueryState header={header} query={documents}>
      {() => {
        const rows = documents.data ?? [];
        return (
          <>
            {rows.length === 0 ? (
              <EmptyState
                icon={FileText}
                title="No policies yet"
                description="Create a policy document, write its first version as a draft, then publish it with an effective date."
                action={<Button onClick={() => setCreating(true)}>Create the first policy</Button>}
              />
            ) : (
              <DataTable<PolicyDocumentSummary>
                caption="Policy documents"
                rows={rows}
                rowKey={(row) => row.documentPublicId}
                columns={[
                  {
                    key: "title",
                    header: "Policy",
                    primary: true,
                    cell: (row) => (
                      <span className="flex min-w-0 flex-col">
                        <Link href={`/admin/policies/${row.documentPublicId}`} className="font-semibold break-words text-action underline-offset-2 hover:underline">
                          {row.title}
                        </Link>
                        <span className="text-sm break-all text-muted">{row.slug}</span>
                      </span>
                    ),
                  },
                  { key: "audience", header: "Audience", cell: (row) => AUDIENCE_LABELS[row.audience] },
                  {
                    key: "required",
                    header: "Acceptance",
                    cell: (row) => (row.requiresAcceptance ? <Badge tone="info">{row.requiresTypedSignature ? "Required, typed signature" : "Required"}</Badge> : <Badge>Informational</Badge>),
                  },
                  {
                    key: "current",
                    header: "Current version",
                    cell: (row) =>
                      row.currentPublishedVersion ? (
                        <span className="flex flex-col">
                          <span>
                            v{row.currentPublishedVersion.versionNumber} · {row.currentPublishedVersion.versionLabel}
                          </span>
                          <span className="text-sm text-muted">
                            Effective <DateTime value={row.currentPublishedVersion.effectiveAt} format="date" />
                          </span>
                        </span>
                      ) : (
                        <span className="text-muted">Not published</span>
                      ),
                  },
                  { key: "drafts", header: "Drafts", align: "end", hideOnMobile: true, cell: (row) => row.draftCount },
                  { key: "active", header: "Status", cell: (row) => <Badge tone={row.active ? "success" : "neutral"}>{row.active ? "Active" : "Retired"}</Badge> },
                ]}
              />
            )}
            {creating ? <CreatePolicyDialog onClose={() => setCreating(false)} /> : null}
          </>
        );
      }}
    </QueryState>
  );
}

function CreatePolicyDialog({ onClose }: { onClose: () => void }) {
  const trpc = useTRPC();
  const [, navigate] = useLocation();
  const guarded = useGuardedAction();
  const create = useMutation(trpc.compliance.policies.admin.createDocument.mutationOptions());
  const [values, setValues] = useState({ slug: "", title: "", audience: "customer" as PolicyAudience, requiresAcceptance: true, requiresTypedSignature: false, versionLabel: "1.0", contentFormat: "safe_markdown" as PolicyFormat, bodyText: "", changeSummary: "" });
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof values) => (event: { target: { value: string } }) => setValues((current) => ({ ...current, [key]: event.target.value }));
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!SLUG.test(values.slug) || values.slug.length < 2 || values.slug.length > 64) return setError("The address name must be 2–64 lowercase letters, digits and single hyphens, e.g. terms-of-service.");
    if (values.title.trim().length < 2) return setError("Enter a title of at least 2 characters.");
    if (!values.versionLabel.trim()) return setError("Enter a version label such as 1.0.");
    if (values.bodyText.trim().length < 10) return setError("The policy text must be at least 10 characters.");
    setError(null);
    const result = await guarded(
      () =>
        create.mutateAsync({
          slug: values.slug,
          title: values.title.trim(),
          audience: values.audience,
          requiresAcceptance: values.requiresAcceptance,
          requiresTypedSignature: values.requiresAcceptance && values.requiresTypedSignature,
          versionLabel: values.versionLabel.trim(),
          contentFormat: values.contentFormat,
          bodyText: values.bodyText,
          changeSummary: values.changeSummary.trim() || undefined,
        }),
      { reason: "Managing policies needs verification.", success: "Policy created as a draft" },
    );
    if (!result.ok) return setError(result.error);
    onClose();
    navigate(`/admin/policies/${result.value.documentPublicId}`);
  };
  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(open) => (open ? undefined : onClose())}
      title="New policy"
      description="The first version is saved as a draft. Nothing is shown to customers until you publish it."
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
            <Input value={values.title} onChange={set("title")} maxLength={160} />
          </Field>
          <Field label="Address name" hint="Permanent, used in the public link, e.g. terms-of-service." required>
            <Input value={values.slug} onChange={(event) => setValues((c) => ({ ...c, slug: event.target.value.toLowerCase() }))} maxLength={64} autoComplete="off" spellCheck={false} />
          </Field>
        </div>
        <Field label="Audience">
          <Select options={AUDIENCE_OPTIONS} value={values.audience} onChange={(event) => setValues((c) => ({ ...c, audience: event.target.value as PolicyAudience }))} />
        </Field>
        <Checkbox label="Acceptance required" description="People in the audience must accept the current version before continuing." checked={values.requiresAcceptance} onCheckedChange={(checked) => setValues((c) => ({ ...c, requiresAcceptance: checked }))} />
        {values.requiresAcceptance ? (
          <Checkbox label="Require a typed signature" checked={values.requiresTypedSignature} onCheckedChange={(checked) => setValues((c) => ({ ...c, requiresTypedSignature: checked }))} />
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Version label" required>
            <Input value={values.versionLabel} onChange={set("versionLabel")} maxLength={32} />
          </Field>
          <Field label="Format">
            <Select options={FORMAT_OPTIONS} value={values.contentFormat} onChange={(event) => setValues((c) => ({ ...c, contentFormat: event.target.value as PolicyFormat }))} />
          </Field>
        </div>
        <Field label="Policy text" required hint="Formatted text supports # headings, - lists, **bold** and `code`. HTML and links are never rendered.">
          <Textarea value={values.bodyText} onChange={set("bodyText")} rows={10} />
        </Field>
        <Field label="Change summary" hint="Optional. Shown with the version history.">
          <Input value={values.changeSummary} onChange={set("changeSummary")} maxLength={500} />
        </Field>
      </form>
    </Dialog>
  );
}

/** Exported for the version editor: converts an optional local datetime to a Date (undefined when blank). */
export function optionalDate(value: string): Date | undefined {
  return fromLocalInput(value) ?? undefined;
}
