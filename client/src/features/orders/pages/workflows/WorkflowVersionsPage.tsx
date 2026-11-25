/** Published versions of one workflow (/admin/workflows/:workflowId/versions). Owner: orders_engineer. Read-only. */
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { useTRPC } from "@/lib/trpc";
import { Badge, Breadcrumbs, DataTable, DateTime, ErrorState, PageHeader, Skeleton } from "@/ui";

export default function WorkflowVersionsPage() {
  const { workflowId = "" } = useParams<{ workflowId: string }>();
  const trpc = useTRPC();
  const versions = useQuery(trpc.orders.admin.workflows.versions.queryOptions({ workflowId }));
  const name = versions.data?.workflow.name;
  const header = (
    <PageHeader
      title={name ? `${name}: versions` : "Workflow versions"}
      description="Each publish creates a new version. Orders stay on the version they started with."
      breadcrumbs={<Breadcrumbs items={[{ label: "Workflows", href: "/admin/workflows" }, { label: name ?? "Versions" }]} />}
    />
  );
  if (versions.isPending)
    return (
      <>
        {header}
        <Skeleton lines={6} />
      </>
    );
  if (versions.error)
    return (
      <>
        {header}
        <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />
      </>
    );
  return (
    <>
      {header}
      <DataTable
        caption={`Versions of ${versions.data.workflow.name}`}
        rows={versions.data.versions}
        rowKey={(version) => version.publicId}
        empty="No published versions."
        columns={[
          {
            key: "version",
            header: "Version",
            primary: true,
            cell: (version) => (
              <span className="inline-flex flex-wrap items-center gap-2">
                <Link href={`/admin/workflows/versions/${version.publicId}`} className="font-semibold text-link underline-offset-2 hover:underline">
                  {`Version ${version.versionNumber}`}
                </Link>
                {version.isCurrent ? <Badge tone="brand">Current</Badge> : null}
              </span>
            ),
          },
          { key: "created", header: "Published", cell: (version) => <DateTime value={version.createdAt} /> },
          {
            key: "shape",
            header: "Shape",
            hideOnMobile: true,
            cell: (version) => `${version.stageCount ? `${version.stageCount} phase${version.stageCount === 1 ? "" : "s"}, ` : ""}${version.stateCount} statuses, ${version.transitionCount} transitions`,
          },
          { key: "orders", header: "Orders on it", align: "end", cell: (version) => version.orderCount },
          { key: "note", header: "Change note", hideOnMobile: true, cell: (version) => version.changeNote ?? "—" },
        ]}
      />
    </>
  );
}
