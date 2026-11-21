/** Read-only view of one published workflow version (/admin/workflows/versions/:versionId). Owner: orders_engineer. */
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useParams } from "wouter";
import { useTRPC } from "@/lib/trpc";
import { Badge, Breadcrumbs, Callout, DateTime, ErrorState, FlowCanvas, KeyValueList, PageHeader, Skeleton, type FlowSelection } from "@/ui";
import { DefinitionTables, toCanvas } from "./WorkflowDesignerPage";

export default function WorkflowVersionPage() {
  const { versionId = "" } = useParams<{ versionId: string }>();
  const trpc = useTRPC();
  const version = useQuery(trpc.orders.admin.workflows.version.queryOptions({ versionId }));
  const [selected, setSelected] = useState<FlowSelection>(null);
  const data = version.data;
  const graph = useMemo(() => (data ? toCanvas(data.definition, data.layout ?? { nodes: [] }) : { nodes: [], edges: [] }), [data]);
  const title = data ? `${data.workflowName}: version ${data.versionNumber}` : "Workflow version";
  const header = (
    <PageHeader
      title={title}
      meta={data?.isCurrent ? <Badge tone="brand">Current</Badge> : data ? <Badge tone="neutral">Earlier version</Badge> : null}
      breadcrumbs={
        <Breadcrumbs items={[{ label: "Workflows", href: "/admin/workflows" }, ...(data ? [{ label: data.workflowName, href: `/admin/workflows/${data.workflowPublicId}/versions` }] : []), { label: data ? `Version ${data.versionNumber}` : "Version" }]} />
      }
    />
  );
  if (version.isPending)
    return (
      <>
        {header}
        <Skeleton lines={8} />
      </>
    );
  if (version.error || !data)
    return (
      <>
        {header}
        <ErrorState error={version.error} onRetry={() => void version.refetch()} />
      </>
    );
  return (
    <>
      {header}
      <div className="flex flex-col gap-6">
        <Callout tone="info">Published versions cannot be changed. To change this workflow, edit it from the Workflows page; publishing creates a new version.</Callout>
        <KeyValueList
          items={[
            { label: "Published", value: <DateTime value={data.createdAt} /> },
            { label: "Change note", value: data.changeNote ?? "—" },
          ]}
        />
        <FlowCanvas label={`Workflow canvas, version ${data.versionNumber} (read-only)`} readOnly height="md" nodes={graph.nodes} edges={graph.edges} selected={selected} onSelect={setSelected} />
        <DefinitionTables definition={data.definition} caption={` in version ${data.versionNumber}`} />
      </div>
    </>
  );
}
