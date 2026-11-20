import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { useTRPC } from "@/lib/trpc";
import { Badge, Button, Card, ErrorState, Skeleton } from "@/ui";

export default function ConsoleQueueWidget() {
  const trpc = useTRPC();
  const queue = useQuery(trpc.engagement.tickets.admin.queueSummary.queryOptions({}));
  const inbox = useQuery(
    trpc.engagement.messages.adminInbox.queryOptions({
      unreadOnly: true,
      visibility: "customer",
      limit: 10,
    }),
  );

  const loading = queue.isPending || inbox.isPending;
  const error = queue.error ?? inbox.error;

  return (
    <Card
      title="Support & messaging queue"
      actions={
        <Button asChild size="sm" variant="secondary">
          <Link href="/admin/tickets">Open queue</Link>
        </Button>
      }
    >
      {loading ? (
        <Skeleton lines={3} />
      ) : error ? (
        <ErrorState
          error={error}
          onRetry={() => {
            void queue.refetch();
            void inbox.refetch();
          }}
        />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-[var(--radius-card)] border border-line bg-surface-soft p-3">
              <p className="text-xs text-muted">Active open</p>
              <p className="mt-1 text-xl font-semibold text-ink">{queue.data?.openCount ?? 0}</p>
            </div>
            <div className="rounded-[var(--radius-card)] border border-line bg-surface-soft p-3">
              <p className="text-xs text-muted">Unassigned</p>
              <p className="mt-1 text-xl font-semibold text-ink">{queue.data?.unassignedCount ?? 0}</p>
            </div>
            <div className="rounded-[var(--radius-card)] border border-line bg-surface-soft p-3">
              <p className="text-xs text-muted">Assigned to me</p>
              <p className="mt-1 text-xl font-semibold text-ink">{queue.data?.assignedToMeCount ?? 0}</p>
            </div>
            <div className="rounded-[var(--radius-card)] border border-line bg-surface-soft p-3">
              <p className="text-xs text-muted">Unread messages</p>
              <p className="mt-1 text-xl font-semibold text-ink">
                {inbox.data?.items.length ?? 0}
                {inbox.data?.nextCursor ? "+" : ""}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <Badge tone={(queue.data?.unassignedCount ?? 0) > 0 ? "warning" : "neutral"}>
              {queue.data?.openCount ?? 0} active in queue
            </Badge>
            <Button asChild size="sm" variant="ghost">
              <Link href="/admin/messages">Order message inbox</Link>
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
