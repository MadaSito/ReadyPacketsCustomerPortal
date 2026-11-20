/** Customer dashboard widget: recent orders. Owner: orders_engineer. */
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { useTRPC } from "@/lib/trpc";
import { Button, Card, DateTime, ErrorState, Skeleton } from "@/ui";
import { OrderStatusBadge } from "./shared";

export default function RecentOrdersWidget() {
  const trpc = useTRPC();
  const list = useQuery(trpc.orders.list.queryOptions({ limit: 5 }));
  return (
    <Card
      title="Recent orders"
      actions={
        <Button asChild size="sm" variant="secondary">
          <Link href="/orders">View all orders</Link>
        </Button>
      }
    >
      {list.isPending ? (
        <Skeleton lines={3} />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-body">You have no orders yet.</p>
          <Button asChild size="sm">
            <Link href="/orders/new">Start an order</Link>
          </Button>
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {list.data.items.map((order) => (
            <li key={order.publicId} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="flex min-w-0 flex-col">
                <Link href={`/orders/${order.publicId}`} className="font-semibold break-words text-action underline-offset-2 hover:underline">
                  {order.projectName}
                </Link>
                <span className="text-sm text-muted">
                  {order.reference} · updated <DateTime value={order.updatedAt} format="relative" />
                </span>
              </span>
              <OrderStatusBadge label={order.statusLabel} tone={order.statusTone} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
