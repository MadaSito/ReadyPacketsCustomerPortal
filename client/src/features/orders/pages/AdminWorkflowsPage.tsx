/**
 * Console workflows (/admin/workflows). Owner: orders_engineer.
 * Lists workflows and open drafts; starts drafts (standard, blank, copy) that the designer edits. Publishing happens
 * in the designer and always creates a new version; orders stay bound to the version they started on.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Workflow } from "lucide-react";
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { errorMessage, safeError, useTRPC } from "@/lib/trpc";
import { Badge, Button, Callout, Card, ConfirmDialog, DataTable, DateTime, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, RadioGroup, Select, Skeleton, StepUpCancelledError, useStepUp, useToast } from "@/ui";
import { OrderStatusBadge } from "../shared";
import { keyFromLabel, type DraftListRow, type WorkflowListRow } from "./workflows/model";
import { useWorkflowTransfer } from "./workflows/useWorkflowTransfer";

export default function AdminWorkflowsPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();
  const stepUp = useStepUp();
  const [, navigate] = useLocation();
  const workflows = useQuery(trpc.orders.admin.workflows.list.queryOptions());
  const drafts = useQuery(trpc.orders.admin.workflows.drafts.list.queryOptions());
  const install = useMutation(trpc.orders.admin.workflows.installStandard.mutationOptions());
  const createDraft = useMutation(trpc.orders.admin.workflows.drafts.create.mutationOptions());
  const [creating, setCreating] = useState(false);
  const [discarding, setDiscarding] = useState<DraftListRow | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.orders.admin.workflows.list.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.orders.admin.workflows.drafts.list.queryKey() }),
    ]);
  const transfer = useWorkflowTransfer(workflows.data ?? [], drafts.data ?? [], () => void refresh());

  const installStandard = async () => {
    setProblem(null);
    try {
      const result = await stepUp.run(() => install.mutateAsync(), { reason: "Installing the standard workflow." });
      toast.show({ tone: "success", title: result.installed ? "Standard workflow installed" : "The standard workflow was already installed" });
      await refresh();
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) setProblem(errorMessage(err));
    }
  };

  const edit = async (wf: WorkflowListRow) => {
    setProblem(null);
    if (wf.draftPublicId) return navigate(`/admin/workflows/drafts/${wf.draftPublicId}`);
    if (!wf.currentVersionPublicId) return setProblem("This workflow has no published version to start from.");
    try {
      const draft = await createDraft.mutateAsync({ from: "copy", copyVersionId: wf.currentVersionPublicId, workflowId: wf.publicId });
      await refresh();
      navigate(`/admin/workflows/drafts/${draft.publicId}`);
    } catch (err) {
      const existing = (safeError(err)?.details as { draftId?: unknown } | undefined)?.draftId;
      if (typeof existing === "string") return navigate(`/admin/workflows/drafts/${existing}`);
      setProblem(errorMessage(err));
    }
  };

  const header = (
    <PageHeader
      title="Workflows"
      description="Order statuses and who may move an order between them. Publishing creates a new version; existing orders keep theirs."
      actions={workflows.data ? <><Button onClick={() => setCreating(true)}>New workflow</Button>{transfer.importAction}</> : null}
    />
  );
  if (workflows.isPending)
    return (
      <>
        {header}
        <Skeleton lines={6} />
      </>
    );
  if (workflows.error)
    return (
      <>
        {header}
        <ErrorState error={workflows.error} onRetry={() => void workflows.refetch()} />
      </>
    );
  const rows = workflows.data;
  const draftRows = drafts.data ?? [];
  return (
    <>
      {header}
      <div className="flex flex-col gap-6">
        {transfer.toolbar}
        {problem ? (
          <Callout tone="danger" live="assertive">
            {problem}
          </Callout>
        ) : null}
        {rows.length === 0 ? (
          <EmptyState
            icon={Workflow}
            title="No workflow installed yet"
            description="Install the standard workflow (Submitted, In review, Waiting on customer, Completed, Cancelled) now, or design your own with New workflow."
            action={
              <Button loading={install.isPending} onClick={() => void installStandard()}>
                Install the standard workflow now
              </Button>
            }
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {rows.map((wf) => (
              <Card
                key={wf.publicId}
                as="article"
                title={wf.name}
                description={`${wf.workflowKey} · version ${wf.versionNumber}`}
                actions={wf.isDefault ? <Badge tone="brand">Default</Badge> : null}
                footer={
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="secondary" aria-label={`${wf.draftPublicId ? "Continue draft" : "Edit"} ${wf.name}`} loading={createDraft.isPending && createDraft.variables?.workflowId === wf.publicId} onClick={() => void edit(wf)}>
                      {wf.draftPublicId ? "Continue draft" : "Edit"}
                    </Button>
                    <Link href={`/admin/workflows/${wf.publicId}/versions`} aria-label={`Versions of ${wf.name}`} className="text-sm font-semibold text-link underline-offset-2 hover:underline">
                      Versions
                    </Link>
                    {transfer.exportAction(wf.workflowKey, wf.name)}
                  </div>
                }
              >
                <div className="grid min-w-0 gap-3">
                  {transfer.selectionControl(wf.workflowKey, wf.name)}
                  {wf.definition ? (
                    <ul aria-label={`Statuses in ${wf.name}`} className="flex flex-wrap gap-2">
                      {wf.definition.states.map((state) => (
                        <li key={state.key}>
                          <OrderStatusBadge label={state.label} tone={state.tone} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-body">No published version.</p>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
        <DataTable
          caption="Drafts"
          showCaption
          rows={draftRows}
          rowKey={(draft) => draft.publicId}
          empty={drafts.isPending ? "Loading drafts…" : "No drafts. Edit a workflow or start a new one."}
          columns={[
            {
              key: "name",
              header: "Draft",
              primary: true,
              cell: (draft) => (
                <div className="grid min-w-0 gap-2">
                  <Link href={`/admin/workflows/drafts/${draft.publicId}`} className="font-semibold text-link underline-offset-2 hover:underline">
                    {draft.name}
                  </Link>
                  {draft.workflowPublicId === null ? transfer.selectionControl(draft.workflowKey, draft.name) : null}
                </div>
              ),
            },
            { key: "kind", header: "For", cell: (draft) => (draft.workflowPublicId ? `New version of ${draft.workflowKey}` : `New workflow ${draft.workflowKey}`) },
            {
              key: "issues",
              header: "Problems",
              cell: (draft) =>
                draft.errorCount ? <Badge tone="danger">{`${draft.errorCount} to fix`}</Badge> : draft.warningCount ? <Badge tone="warning">{`${draft.warningCount} warning${draft.warningCount === 1 ? "" : "s"}`}</Badge> : <Badge tone="success">Ready</Badge>,
            },
            { key: "updated", header: "Last saved", hideOnMobile: true, cell: (draft) => <DateTime value={draft.updatedAt} /> },
          ]}
          rowActions={(draft) => (
            <div className="flex flex-wrap gap-2 md:justify-end">
              {draft.workflowPublicId === null ? transfer.exportAction(draft.workflowKey, draft.name) : null}
              <Button size="sm" variant="ghost" aria-label={`Discard draft ${draft.name}`} onClick={() => setDiscarding(draft)}>
                Discard
              </Button>
            </div>
          )}
        />
      </div>
      {creating ? <NewWorkflowDialog workflows={rows} onClose={() => setCreating(false)} onCreated={(id) => void refresh().then(() => navigate(`/admin/workflows/drafts/${id}`))} /> : null}
      {discarding ? <DiscardDialog draft={discarding} onClose={() => setDiscarding(null)} onDone={() => void refresh()} /> : null}
      {transfer.dialog}
    </>
  );
}

function NewWorkflowDialog({ workflows, onClose, onCreated }: { workflows: WorkflowListRow[]; onClose: () => void; onCreated: (draftId: string) => void }) {
  const trpc = useTRPC();
  const create = useMutation(trpc.orders.admin.workflows.drafts.create.mutationOptions());
  const copyable = workflows.filter((wf) => wf.currentVersionPublicId);
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [from, setFrom] = useState<"standard" | "blank" | "copy">("standard");
  const [copyFrom, setCopyFrom] = useState(copyable[0]?.currentVersionPublicId ?? "");
  const [errors, setErrors] = useState<{ name?: string; key?: string; copy?: string; form?: string }>({});
  const taken = new Set(workflows.map((wf) => wf.workflowKey));

  const submit = async () => {
    const next: typeof errors = {};
    if (!name.trim()) next.name = "Enter a name.";
    if (!/^[a-z][a-z0-9_]{1,47}$/.test(key)) next.key = "Use 2 to 48 lowercase letters, digits or underscores, starting with a letter.";
    else if (taken.has(key)) next.key = "A workflow with this key already exists.";
    if (from === "copy" && !copyFrom) next.copy = "Choose the workflow to copy.";
    setErrors(next);
    if (Object.keys(next).length) return;
    try {
      const draft = await create.mutateAsync({ from, workflowKey: key, name: name.trim(), ...(from === "copy" ? { copyVersionId: copyFrom } : {}) });
      onClose();
      onCreated(draft.publicId);
    } catch (err) {
      const code = safeError(err)?.reasonCode;
      setErrors(code === "WORKFLOW_KEY_TAKEN" ? { key: errorMessage(err) } : { form: errorMessage(err) });
    }
  };

  return (
    <Dialog
      open
      size="md"
      onOpenChange={(open) => (open ? undefined : onClose())}
      title="New workflow"
      description="This starts a draft. Nothing changes for orders until you publish it."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button loading={create.isPending} onClick={() => void submit()}>
            Create draft
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {errors.form ? (
          <Callout tone="danger" live="assertive">
            {errors.form}
          </Callout>
        ) : null}
        <Field label="Name" required error={errors.name}>
          <Input
            value={name}
            maxLength={120}
            onChange={(event) => {
              setName(event.target.value);
              if (!keyTouched) setKey(keyFromLabel(event.target.value, taken));
            }}
          />
        </Field>
        <Field label="Key" required hint="Lowercase letters, digits and underscores. It cannot be changed later." error={errors.key}>
          <Input
            value={key}
            maxLength={48}
            spellCheck={false}
            autoCapitalize="none"
            className="font-mono"
            onChange={(event) => {
              setKeyTouched(true);
              setKey(event.target.value.toLowerCase());
            }}
          />
        </Field>
        <RadioGroup
          legend="Start from"
          value={from}
          onValueChange={(value) => setFrom(value as typeof from)}
          options={[
            { value: "standard", label: "The standard workflow", description: "Submitted, In review, Waiting on customer, Completed, Cancelled." },
            { value: "blank", label: "Blank", description: "Only a start status and a final status." },
            { value: "copy", label: "A copy of an existing workflow", description: "Its current published version.", disabled: copyable.length === 0 },
          ]}
        />
        {from === "copy" ? (
          <Field label="Workflow to copy" required error={errors.copy}>
            <Select value={copyFrom} options={copyable.map((wf) => ({ value: wf.currentVersionPublicId!, label: `${wf.name} (version ${wf.versionNumber})` }))} onChange={(event) => setCopyFrom(event.target.value)} />
          </Field>
        ) : null}
      </div>
    </Dialog>
  );
}

function DiscardDialog({ draft, onClose, onDone }: { draft: DraftListRow; onClose: () => void; onDone: () => void }) {
  const trpc = useTRPC();
  const toast = useToast();
  const discard = useMutation(trpc.orders.admin.workflows.drafts.discard.mutationOptions());
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={`Discard the draft “${draft.name}”?`}
      description="The draft's unpublished changes are deleted. Published versions are not affected."
      confirmLabel="Discard draft"
      destructive
      onConfirm={async () => {
        try {
          await discard.mutateAsync({ draftId: draft.publicId, expectedVersion: draft.rowVersion });
          toast.show({ tone: "success", title: "Draft discarded" });
          onDone();
          onClose();
        } catch (err) {
          setProblem(errorMessage(err));
          throw err;
        }
      }}
    >
      {problem ? (
        <Callout tone="danger" live="assertive">
          {problem}
        </Callout>
      ) : null}
    </ConfirmDialog>
  );
}
