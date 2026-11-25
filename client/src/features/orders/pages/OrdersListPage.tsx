/** Customer order list (/orders). Owner: orders_engineer. */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Package, Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { Button, Card, DataTable, DateTime, EmptyState, LoadMore, Money, PageHeader, useToast } from "@/ui";
import { ACCESS_ROLE_LABELS, LockBadge, OrderStatusBadge, money, type LockState } from "../shared";
import { OrderListProgress } from "../stages/OrderListProgress";

export default function OrdersListPage() {
  const trpc = useTRPC();
  const list = useInfiniteQuery(trpc.orders.list.infiniteQueryOptions({ limit: 25 }, { getNextPageParam: (page) => page.nextCursor ?? undefined }));
  const rows = list.data?.pages.flatMap((page) => page.items);
  return (
    <>
      <PageHeader
        title="Orders"
        description="Track the status of every order you own or that has been shared with you."
        actions={
          <Button asChild leadingIcon={<Plus aria-hidden />}>
            <Link href="/orders/new">New order</Link>
          </Button>
        }
      />
      <div className="flex flex-col gap-6">
        <PendingInvitations />
        <DataTable
          caption="Your orders"
          rows={rows}
          loading={list.isPending}
          error={list.error}
          onRetry={() => void list.refetch()}
          rowKey={(order) => order.publicId}
          columns={[
            {
              key: "reference",
              header: "Order",
              primary: true,
              cell: (order) => (
                <span className="flex min-w-0 flex-col">
                  <Link href={`/orders/${order.publicId}`} className="font-semibold break-words text-action underline-offset-2 hover:underline">
                    {order.projectName}
                  </Link>
                  <span className="text-sm text-muted">{order.reference}</span>
                </span>
              ),
            },
            {
              key: "status",
              header: "Status",
              cell: (order) => (
                <span className="flex flex-wrap gap-1">
                  <OrderStatusBadge label={order.statusLabel} tone={order.statusTone} />
                  <LockBadge state={order.lockState as LockState} />
                </span>
              ),
            },
            { key: "progress", header: "Progress", cell: (order) => <OrderListProgress name={order.projectName} progressPercent={order.progressPercent} phaseLabel={order.phaseLabel} phaseIndex={order.phaseIndex} phaseTotal={order.phaseTotal} canceled={order.progressCanceled} className="min-w-40" /> },
            { key: "access", header: "Access", hideOnMobile: true, cell: (order) => ACCESS_ROLE_LABELS[order.accessRole] ?? order.accessRole },
            { key: "updatedAt", header: "Updated", cell: (order) => <DateTime value={order.updatedAt} format="relative" /> },
            { key: "total", header: "Total", align: "end", cell: (order) => <Money value={money(order.totalMinor, order.currency)} /> },
          ]}
          empty={
            <EmptyState
              icon={Package}
              title="No orders yet"
              description="When you place an order, or someone shares one with you, it appears here."
              action={
                <Button asChild>
                  <Link href="/orders/new">Start an order</Link>
                </Button>
              }
            />
          }
        />
        <LoadMore
          hasMore={!!list.hasNextPage}
          loading={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
          summary={rows ? `Showing ${rows.length} ${rows.length === 1 ? "order" : "orders"}` : undefined}
        />
      </div>
    </>
  );
}

/** Invitations addressed to my verified e-mail. Hidden entirely when there are none. */
function PendingInvitations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();
  const invitations = useQuery(trpc.orders.sharing.myInvitations.queryOptions());
  const respond = useMutation(trpc.orders.sharing.respond.mutationOptions());
  const [busy, setBusy] = useState<string | null>(null);
  if (!invitations.data || invitations.data.length === 0) return null;
  const answer = async (grantId: string, accept: boolean) => {
    setBusy(grantId);
    try {
      await respond.mutateAsync({ grantId, accept });
      toast.show({ tone: "success", title: accept ? "Invitation accepted" : "Invitation declined" });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: trpc.orders.sharing.myInvitations.queryKey() }),
        queryClient.invalidateQueries({ queryKey: trpc.orders.list.pathKey() }),
      ]);
    } catch (error) {
      toast.show({ tone: "danger", title: "Could not respond to the invitation", description: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card title="Shared with you" description="You have been invited to view or contribute to these orders.">
      <ul className="flex flex-col divide-y divide-line">
        {invitations.data.map((invite) => (
          <li key={invite.publicId} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="font-semibold break-words text-ink">{invite.projectName}</p>
              <p className="text-sm text-muted">
                {invite.orderReference} · {invite.role === "contributor" ? "Contributor" : "Viewer"}
                {invite.expiresAt ? (
                  <>
                    {" "}
                    · expires <DateTime value={invite.expiresAt} format="date" />
                  </>
                ) : null}
              </p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void answer(invite.publicId, false)}>
                Decline{" "}<span className="sr-only">invitation to {invite.projectName}</span>
              </Button>
              <Button size="sm" loading={busy === invite.publicId} disabled={busy !== null} onClick={() => void answer(invite.publicId, true)}>
                Accept{" "}<span className="sr-only">invitation to {invite.projectName}</span>
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
