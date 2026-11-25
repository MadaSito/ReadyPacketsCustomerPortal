/**
 * Console overview widget: orders needing staff attention + newest orders. Owner: orders_engineer.
 * Uses only `orders.admin.list` (orders.read_all, no step-up). Counts are per status, capped at one page:
 * when more exist the count is shown as "N+" rather than guessed.
 */
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { useTRPC } from "@/lib/trpc";
import { Button, Card, DateTime, ErrorState, Skeleton } from "@/ui";
import { OrderStatusBadge } from "./shared";

/** Default-workflow states where staff action is expected. Labels come from the server when orders exist. */
export const PIPELINE_STATUSES = [
  { key: "submitted", fallback: "Submitted" },
  { key: "in_review", fallback: "In review" },
  { key: "awaiting_customer", fallback: "Awaiting customer" },
  { key: "in_progress", fallback: "In progress" },
] as const;
const COUNT_PAGE = 100;

export default function OrdersPipelineWidget() {
  const trpc = useTRPC();
  const attentionCounts = useQuery(trpc.orders.statusCatalog.attentionCounts.queryOptions(undefined, { retry: false }));
  const counts = useQueries({
    queries: PIPELINE_STATUSES.map((status) => trpc.orders.admin.list.queryOptions({ status: status.key, limit: COUNT_PAGE })),
  });
  const recent = useQuery(trpc.orders.admin.list.queryOptions({ limit: 5 }));
  const failed = [recent, ...counts].find((query) => query.isError);
  const ready = recent.isSuccess && !attentionCounts.isPending && counts.every((query) => query.isSuccess);

  return (
    <Card
      title="Orders pipeline"
      actions={
        <Button asChild size="sm" variant="secondary">
          <Link href="/admin/orders">All orders</Link>
        </Button>
      }
    >
      {failed ? (
        <ErrorState
          error={failed.error}
          title="We couldn't load the orders pipeline"
          onRetry={() => {
            void recent.refetch();
            void attentionCounts.refetch();
            for (const query of counts) void query.refetch();
          }}
        />
      ) : !ready ? (
        <Skeleton lines={4} />
      ) : (
        <div className="flex flex-col gap-4">
          {attentionCounts.data ? (
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-[var(--radius-card)] border border-line bg-surface-soft p-3">
                <dt className="text-xs text-muted">Awaiting staff review</dt>
                <dd className="mt-1 text-xl font-semibold text-ink">
                  <Link
                    href="/admin/orders?attention=staff_review"
                    className="inline-flex min-h-6 min-w-6 items-center justify-center rounded-sm underline-offset-2 hover:underline"
                  >
                    {attentionCounts.data.staffReview}{" "}
                    <span className="sr-only">orders awaiting staff review</span>
                  </Link>
                </dd>
              </div>
              <div className="rounded-[var(--radius-card)] border border-line bg-surface-soft p-3">
                <dt className="text-xs text-muted">Awaiting customer response</dt>
                <dd className="mt-1 text-xl font-semibold text-ink">
                  <Link
                    href="/admin/orders?attention=customer_response"
                    className="inline-flex min-h-6 min-w-6 items-center justify-center rounded-sm underline-offset-2 hover:underline"
                  >
                    {attentionCounts.data.customerResponse}{" "}
                    <span className="sr-only">orders awaiting customer response</span>
                  </Link>
                </dd>
              </div>
            </dl>
          ) : null}
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {PIPELINE_STATUSES.map((status, index) => {
              const data = counts[index]!.data!;
              const label = data.items[0]?.statusLabel ?? status.fallback;
              return (
                <div key={status.key} className="rounded-[var(--radius-card)] border border-line bg-surface-soft p-3">
                  <dt className="text-xs text-muted">{label}</dt>
                  <dd className="mt-1 text-xl font-semibold text-ink">
                    <Link
                      href={`/admin/orders?status=${status.key}`}
                      className="inline-flex min-h-6 min-w-6 items-center justify-center rounded-sm underline-offset-2 hover:underline"
                    >
                      {data.items.length}
                      {data.nextCursor ? "+" : ""}{" "}
                      <span className="sr-only">{label} orders</span>
                    </Link>
                  </dd>
                </div>
              );
            })}
          </dl>
          <div>
            <h3 className="text-sm font-semibold text-ink">Newest orders</h3>
            {recent.data!.items.length === 0 ? (
              <p className="mt-2 text-body">No orders have been placed yet.</p>
            ) : (
              <ul className="mt-1 flex flex-col divide-y divide-line">
                {recent.data!.items.map((order) => (
                  <li key={order.publicId} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between">
                    <span className="flex min-w-0 flex-col">
                      <Link href={`/admin/orders/${order.publicId}`} className="font-semibold break-words text-action underline-offset-2 hover:underline">
                        {order.reference}
                      </Link>
                      <span className="text-sm break-words text-muted">
                        {order.projectName} · updated <DateTime value={order.updatedAt} format="relative" />
                      </span>
                    </span>
                    <span className="w-fit shrink-0 self-start sm:self-center">
                      <OrderStatusBadge label={order.statusLabel} tone={order.statusTone} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
