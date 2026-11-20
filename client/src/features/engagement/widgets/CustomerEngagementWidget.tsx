import { useQuery } from "@tanstack/react-query";
import { LifeBuoy, MessageSquare } from "lucide-react";
import { Link } from "wouter";
import { useTRPC } from "@/lib/trpc";
import { Badge, Button, Card, ErrorState, Skeleton } from "@/ui";

export default function CustomerEngagementWidget() {
  const trpc = useTRPC();
  const unreadMessages = useQuery(trpc.engagement.messages.unreadSummary.queryOptions({}));
  const ticketSummary = useQuery(trpc.engagement.tickets.openSummary.queryOptions({}));

  const loading = unreadMessages.isPending || ticketSummary.isPending;
  const error = unreadMessages.error ?? ticketSummary.error;

  return (
    <Card title="Messages & support">
      {loading ? (
        <Skeleton lines={3} />
      ) : error ? (
        <ErrorState
          error={error}
          onRetry={() => {
            void unreadMessages.refetch();
            void ticketSummary.refetch();
          }}
        />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-2 rounded-[var(--radius-card)] border border-line bg-surface-soft p-3">
            <div className="flex items-center gap-2.5">
              <MessageSquare className="size-5 shrink-0 text-action" aria-hidden="true" />
              <div>
                <p className="font-semibold text-ink">Order messages</p>
                <p className="text-xs text-muted">Across accessible orders</p>
              </div>
            </div>
            <Badge tone={(unreadMessages.data?.totalUnread ?? 0) > 0 ? "brand" : "neutral"}>
              {unreadMessages.data?.totalUnread ?? 0} unread
            </Badge>
          </div>

          <div className="flex items-center justify-between gap-2 rounded-[var(--radius-card)] border border-line bg-surface-soft p-3">
            <div className="flex items-center gap-2.5">
              <LifeBuoy className="size-5 shrink-0 text-action" aria-hidden="true" />
              <div>
                <p className="font-semibold text-ink">Support tickets</p>
                <p className="text-xs text-muted">
                  {(ticketSummary.data?.awaitingCustomerCount ?? 0) > 0
                    ? `${ticketSummary.data?.awaitingCustomerCount} awaiting your reply`
                    : "Active inquiries"}
                </p>
              </div>
            </div>
            <Badge
              tone={
                (ticketSummary.data?.awaitingCustomerCount ?? 0) > 0
                  ? "warning"
                  : (ticketSummary.data?.openCount ?? 0) > 0
                    ? "info"
                    : "neutral"
              }
            >
              {ticketSummary.data?.openCount ?? 0} open
            </Badge>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <Button asChild size="sm" variant="secondary">
              <Link href="/messages">Open messages</Link>
            </Button>
            <Button asChild size="sm" variant="secondary">
              <Link href="/support">Support center</Link>
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
