/** Console policy documents (/admin/policies). Owner: orders_engineer (compliance admin UI). Ships empty; no built-in policies. */
import { useMutation, useQuery } from "@tanstack/react-query";
import { FileText, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { DocumentImportButton } from "@/lib/docconvert";
import { useSession } from "@/lib/session";
import { useTRPC } from "@/lib/trpc";
import { Badge, Button, Callout, Card, Checkbox, DataTable, DateTime, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Select, Skeleton, Textarea } from "@/ui";
import { PolicyDefaultWarningCard } from "../policyUpdates/PolicyEnforcementCards";
import { QueryState, useGuardedAction } from "./common";
import { AUDIENCE_LABELS, FORMAT_LABELS, SLUG, fromLocalInput, type PolicyAudience, type PolicyDocumentSummary, type PolicyFormat } from "./model";

export const AUDIENCE_OPTIONS = (Object.keys(AUDIENCE_LABELS) as PolicyAudience[]).map((value) => ({ value, label: AUDIENCE_LABELS[value] }));
export const FORMAT_OPTIONS = (Object.keys(FORMAT_LABELS) as PolicyFormat[]).map((value) => ({ value, label: FORMAT_LABELS[value] }));

const SIGNATURE_MODE_OPTIONS = [
  { value: "typed_name", label: "Typed full name (signature)" },
  { value: "checkbox", label: "Tick box only" },
] as const;

const SIGNATURE_CHECK_OPTIONS = [
  { value: "require", label: "Require match (refuse mismatched names; default)" },
  { value: "warn", label: "Allow with warning (record mismatch in acceptance log)" },
  { value: "off", label: "Off (record typed name without checking)" },
] as const;

export default function PoliciesAdminPage() {
  const trpc = useTRPC();
  const { me } = useSession();
  const documents = useQuery(trpc.compliance.policies.admin.listDocuments.queryOptions());
  const [creating, setCreating] = useState(false);
  const isAdmin = me?.user.role === "admin";
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
          <div className="flex flex-col gap-6">
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
            {isAdmin ? <OrderAgreementCard /> : null}
            <SignatureNameCheckCard />
            <PolicyDefaultWarningCard />
            {creating ? <CreatePolicyDialog onClose={() => setCreating(false)} /> : null}
          </div>
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
        <div className="flex flex-wrap items-center justify-between gap-2">
          <DocumentImportButton
            label="Import document (.docx, .md, .pdf)"
            disabled={create.isPending}
            onImport={(imported) =>
              setValues((current) => ({
                ...current,
                contentFormat: imported.sourceKind === "pdf" ? "plain_text" : "safe_markdown",
                bodyText: imported.sourceKind === "pdf" ? imported.plainText : imported.markdown,
              }))
            }
          />
        </div>
        <Field label="Policy text" required hint="Formatted text supports # headings, - lists, **bold** and `code`. HTML and links are never rendered. Imported files fill this draft for review and are never published automatically.">
          <Textarea value={values.bodyText} onChange={set("bodyText")} rows={10} />
        </Field>
        <Field label="Change summary" hint="Optional. Shown with the version history.">
          <Input value={values.changeSummary} onChange={set("changeSummary")} maxLength={500} />
        </Field>
      </form>
    </Dialog>
  );
}

function OrderAgreementCard() {
  const trpc = useTRPC();
  const guarded = useGuardedAction();
  const query = useQuery(trpc.orders.admin.agreementGate.get.queryOptions());
  const update = useMutation(trpc.orders.admin.agreementGate.update.mutationOptions());
  return (
    <section id="order-agreement" aria-label="Order agreement (MNDA)">
      <Card
        title="Order agreement (MNDA)"
        headingLevel={2}
        description="Require customers to accept a published agreement before placing an order or working on an order."
      >
        {query.isPending ? (
          <Skeleton lines={4} />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <OrderAgreementForm
            key={`${query.data.enabled}:${query.data.policyPublicId ?? "none"}:${query.data.signatureMode}:${query.data.askAgainOnNewVersion}:${query.data.applyTo.placeOrder}:${query.data.applyTo.workOnOrder}`}
            initial={query.data}
            saving={update.isPending}
            onSave={async (next) => {
              const res = await guarded(
                () => update.mutateAsync({ setting: next, expectedEnabled: query.data.enabled }),
                { reason: "Updating the order agreement requires verification.", success: "Order agreement settings saved" },
              );
              if (!res.ok) return res.error;
              await query.refetch();
              return null;
            }}
          />
        )}
      </Card>
    </section>
  );
}

interface AgreementGateFormData {
  enabled: boolean;
  policyPublicId: string | null;
  applyTo: { placeOrder: boolean; workOnOrder: boolean };
  signatureMode: "checkbox" | "typed_name";
  askAgainOnNewVersion: boolean;
  choices: { publicId: string; title: string; versionLabel: string }[];
}

function OrderAgreementForm({
  initial,
  saving,
  onSave,
}: {
  initial: AgreementGateFormData;
  saving: boolean;
  onSave: (next: Omit<AgreementGateFormData, "choices">) => Promise<string | null>;
}) {
  const [policyPublicId, setPolicyPublicId] = useState<string>(initial.policyPublicId ?? "");
  const [enabled, setEnabled] = useState<boolean>(initial.enabled);
  const [placeOrder, setPlaceOrder] = useState<boolean>(initial.applyTo.placeOrder);
  const [workOnOrder, setWorkOnOrder] = useState<boolean>(initial.applyTo.workOnOrder);
  const [signatureMode, setSignatureMode] = useState<"checkbox" | "typed_name">(initial.signatureMode);
  const [askAgainOnNewVersion, setAskAgainOnNewVersion] = useState<boolean>(initial.askAgainOnNewVersion);
  const [error, setError] = useState<string | null>(null);

  const policyOptions = [
    { value: "", label: initial.choices.length ? "Select a published policy…" : "No published customer policies available" },
    ...initial.choices.map((choice) => ({
      value: choice.publicId,
      label: `${choice.title} (v${choice.versionLabel})`,
    })),
  ];

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (enabled && !policyPublicId) {
      setError("Choose a published policy before turning the order agreement on.");
      return;
    }
    setError(null);
    const err = await onSave({
      enabled: Boolean(policyPublicId) && enabled,
      policyPublicId: policyPublicId || null,
      applyTo: { placeOrder, workOnOrder },
      signatureMode,
      askAgainOnNewVersion,
    });
    if (err) setError(err);
  };

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="flex flex-col gap-4">
      {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
      {initial.choices.length === 0 ? (
        <Callout tone="info">
          Publish an active policy for customers (or everyone) above before turning the order agreement on.
        </Callout>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Agreement policy" hint="Only published policies for customers or everyone can be selected.">
          <Select
            options={policyOptions}
            value={policyPublicId}
            onChange={(event) => {
              const nextPolicy = event.target.value;
              setPolicyPublicId(nextPolicy);
              if (!nextPolicy) setEnabled(false);
            }}
          />
        </Field>
        <Field label="Signature method">
          <Select
            options={[...SIGNATURE_MODE_OPTIONS]}
            value={signatureMode}
            onChange={(event) => setSignatureMode(event.target.value as "checkbox" | "typed_name")}
          />
        </Field>
      </div>
      <Checkbox
        label="Require order agreement"
        description={policyPublicId ? "Customers must accept the selected agreement before gated actions proceed." : "Select a published policy first to enable this requirement."}
        checked={Boolean(policyPublicId) && enabled}
        disabled={!policyPublicId || saving}
        onCheckedChange={setEnabled}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Checkbox
          label="Apply when placing an order"
          description="Checked at order creation and cart checkout."
          checked={placeOrder}
          disabled={saving}
          onCheckedChange={setPlaceOrder}
        />
        <Checkbox
          label="Apply when working on an order"
          description="Checked before file uploads, downloads, recordings, questionnaires and phase submissions."
          checked={workOnOrder}
          disabled={saving}
          onCheckedChange={setWorkOnOrder}
        />
      </div>
      <Checkbox
        label="Ask again when a new version is published"
        description="When off, accepting any version of the selected policy satisfies the agreement."
        checked={askAgainOnNewVersion}
        disabled={saving}
        onCheckedChange={setAskAgainOnNewVersion}
      />
      <div>
        <Button type="submit" variant="secondary" loading={saving}>
          Save order agreement
        </Button>
      </div>
    </form>
  );
}

function SignatureNameCheckCard() {
  const trpc = useTRPC();
  const guarded = useGuardedAction();
  const query = useQuery(trpc.compliance.policies.admin.signatureNameCheck.get.queryOptions());
  const update = useMutation(trpc.compliance.policies.admin.signatureNameCheck.update.mutationOptions());
  const [draftMode, setDraftMode] = useState<"require" | "warn" | "off" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mode = draftMode ?? query.data?.mode ?? "require";

  return (
    <Card
      title="Typed signature name check"
      headingLevel={2}
      description="Compare typed signatures on policies and workflow gates against the signed-in user's account name (normalised case, accents, punctuation, and first + last name when a middle name is on the account)."
    >
      {query.isPending ? (
        <Skeleton lines={2} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            void guarded(
              () => update.mutateAsync({ mode }),
              { reason: "Managing policies needs verification.", success: "Signature check mode saved" },
            ).then(async (res) => {
              if (!res.ok) {
                setError(res.error);
                return;
              }
              setDraftMode(null);
              await query.refetch();
            });
          }}
        >
          {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
          <Field label="Signature verification mode">
            <Select
              options={[...SIGNATURE_CHECK_OPTIONS]}
              value={mode}
              onChange={(event) => setDraftMode(event.target.value as "require" | "warn" | "off")}
            />
          </Field>
          <div>
            <Button type="submit" variant="secondary" loading={update.isPending}>
              Save signature check
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

/** Exported for the version editor: converts an optional local datetime to a Date (undefined when blank). */
export function optionalDate(value: string): Date | undefined {
  return fromLocalInput(value) ?? undefined;
}
