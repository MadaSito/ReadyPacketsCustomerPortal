import { useState } from "react";
import { Link } from "wouter";
import { Bookmark } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { Badge, Button, ConfirmDialog, DataTable, DateTime, EmptyState, PageHeader, useToast } from "@/ui";
import { AuditNav } from "./AuditNav";
import type { SavedQuery } from "./model";

export function SavedQueriesTable({ rows, loading, error, onRetry, onDelete }: {
  rows: readonly SavedQuery[] | undefined; loading: boolean; error: unknown; onRetry: () => void; onDelete: (row: SavedQuery) => void;
}) {
  return (
    <DataTable
      caption="Saved searches"
      rows={rows}
      loading={loading}
      error={error}
      onRetry={onRetry}
      rowKey={(r) => r.id}
      empty={<EmptyState icon={Bookmark} title="No saved searches" description="Use Save search on the Events page to keep a set of filters for later." action={<Button asChild variant="secondary"><Link href="/admin/audit">Go to events</Link></Button>} />}
      columns={[
        { key: "name", header: "Name", primary: true, cell: (r) => <Link href={`/admin/audit?saved=${r.id}`} className="font-medium text-action underline break-words">{r.name}</Link> },
        { key: "visibility", header: "Visibility", cell: (r) => (r.shared ? <Badge tone="info">Shared</Badge> : <Badge>Only me</Badge>) },
        { key: "owner", header: "Owner", cell: (r) => (r.mine ? "You" : "Another administrator") },
        { key: "window", header: "Time window", hideOnMobile: true, cell: (r) => <span><DateTime value={r.query.from} format="date" /> to <DateTime value={r.query.to} format="date" /></span> },
        { key: "updated", header: "Updated", cell: (r) => <DateTime value={r.updatedAt} format="relative" /> },
      ]}
      rowActions={(r) => (r.mine ? <Button size="sm" variant="ghost" onClick={() => onDelete(r)} aria-label={`Delete saved search ${r.name}`}>Delete</Button> : null)}
    />
  );
}

export default function SavedQueriesPage() {
  const trpc = useTRPC();
  const toast = useToast();
  const client = useQueryClient();
  const list = useQuery(trpc.audit.savedQueries.list.queryOptions());
  const remove = useMutation(trpc.audit.savedQueries.remove.mutationOptions());
  const [target, setTarget] = useState<SavedQuery | null>(null);
  return (
    <>
      <PageHeader title="Saved searches" description="Reusable audit searches. Shared searches are visible to every administrator." />
      <AuditNav />
      <SavedQueriesTable rows={list.data} loading={list.isPending} error={list.error} onRetry={() => list.refetch()} onDelete={setTarget} />
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => !open && setTarget(null)}
        title="Delete this saved search?"
        description="The search is removed for everyone it was shared with. Audit events are not affected."
        confirmLabel="Delete search"
        destructive
        onConfirm={async () => {
          if (!target) return;
          try {
            await remove.mutateAsync({ id: target.id });
            await client.invalidateQueries({ queryKey: trpc.audit.savedQueries.list.queryKey() });
            toast.show({ title: "Saved search deleted", tone: "success" });
          } catch (error) {
            toast.show({ title: "Not deleted", description: errorMessage(error), tone: "danger" });
            throw error;
          }
        }}
      />
    </>
  );
}
