/** Console workflow definitions (/admin/workflows). Owner: orders_engineer. Orders stay bound to the version they started on. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Workflow } from "lucide-react";
import { useState } from "react";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { Badge, Button, Callout, Card, Checkbox, DataTable, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Skeleton, Textarea, useToast } from "@/ui";
import { OrderStatusBadge } from "../shared";

type WorkflowRow = {
  publicId: string;
  workflowKey: string;
  name: string;
  isDefault: boolean;
  rowVersion: number;
  versionNumber: number;
  definition: {
    states: { key: string; label: string; customerLabel: string; kind: string; tone: string }[];
    transitions: { from: string; to: string; allowedBy: string[]; notifyCustomer: boolean; requiresNote: boolean }[];
  } | null;
};

const KIND_LABEL: Record<string, string> = { initial: "Start", active: "In progress", terminal: "Final" };

export default function AdminWorkflowsPage() {
  const trpc = useTRPC();
  const workflows = useQuery(trpc.orders.admin.workflows.list.queryOptions());
  const [editing, setEditing] = useState<WorkflowRow | null>(null);
  const header = <PageHeader title="Workflows" description="Order statuses and who may move an order between them. Publishing creates a new version; existing orders keep theirs." />;
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
  const rows = workflows.data as WorkflowRow[];
  return (
    <>
      {header}
      {rows.length === 0 ? (
        <EmptyState icon={Workflow} title="No workflow installed yet" description="The standard workflow is installed automatically when the first order is created." />
      ) : (
        <div className="flex flex-col gap-6">
          {rows.map((wf) => (
            <Card
              key={wf.publicId}
              title={wf.name}
              description={`${wf.workflowKey} · version ${wf.versionNumber}`}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  {wf.isDefault ? <Badge tone="brand">Default</Badge> : null}
                  <Button size="sm" variant="secondary" onClick={() => setEditing(wf)}>
                    Publish new version{" "}<span className="sr-only">of {wf.name}</span>
                  </Button>
                </div>
              }
            >
              {wf.definition ? (
                <div className="grid gap-6 lg:grid-cols-2">
                  <DataTable
                    caption={`Statuses in ${wf.name}`}
                    showCaption
                    rows={wf.definition.states}
                    rowKey={(state) => state.key}
                    columns={[
                      { key: "label", header: "Status", primary: true, cell: (state) => <OrderStatusBadge label={state.label} tone={state.tone} /> },
                      { key: "customer", header: "Customers see", cell: (state) => state.customerLabel },
                      { key: "kind", header: "Stage", hideOnMobile: true, cell: (state) => KIND_LABEL[state.kind] ?? state.kind },
                    ]}
                  />
                  <DataTable
                    caption={`Transitions in ${wf.name}`}
                    showCaption
                    rows={wf.definition.transitions}
                    rowKey={(t) => `${t.from}->${t.to}`}
                    columns={[
                      { key: "move", header: "Move", primary: true, cell: (t) => `${t.from} → ${t.to}` },
                      { key: "who", header: "Allowed for", cell: (t) => t.allowedBy.join(", ") },
                      { key: "note", header: "Note required", hideOnMobile: true, cell: (t) => (t.requiresNote ? "Yes" : "No") },
                    ]}
                  />
                </div>
              ) : (
                <p className="text-body">No published version.</p>
              )}
            </Card>
          ))}
        </div>
      )}
      {editing ? <PublishDialog workflow={editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

function PublishDialog({ workflow, onClose }: { workflow: WorkflowRow; onClose: () => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();
  const publish = useMutation(trpc.orders.admin.workflows.publish.mutationOptions());
  const [name, setName] = useState(workflow.name);
  const [json, setJson] = useState(JSON.stringify(workflow.definition, null, 2));
  const [makeDefault, setMakeDefault] = useState(workflow.isDefault);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    let definition: unknown;
    try {
      definition = JSON.parse(json);
    } catch {
      return setError("The definition is not valid JSON.");
    }
    setError(null);
    try {
      await publish.mutateAsync({ workflowId: workflow.publicId, expectedVersion: workflow.rowVersion, name: name.trim(), definition, makeDefault });
      toast.show({ tone: "success", title: "New workflow version published" });
      await queryClient.invalidateQueries({ queryKey: trpc.orders.admin.workflows.list.queryKey() });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Dialog
      open
      size="xl"
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={`Publish a new version of ${workflow.name}`}
      description="The server validates the definition: unique state keys, exactly one start state, and transitions between known states."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={publish.isPending}>
            Cancel
          </Button>
        <Button loading={publish.isPending} onClick={() => void submit()}>
          Publish
        </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
        <Field label="Name">
          <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} />
        </Field>
        <Field label="Definition (JSON)">
          <Textarea value={json} onChange={(event) => setJson(event.target.value)} rows={16} spellCheck={false} className="font-mono text-sm" />
        </Field>
        <Checkbox label="Use for new orders (default)" checked={makeDefault} onCheckedChange={setMakeDefault} />
      </div>
    </Dialog>
  );
}
