/**
 * S2 — Order history tab (customers see it as "History"). Owner: audit engineer.
 * Left: lifecycle status history and renames (`audit.orderStatusHistory`). Right: order-scoped activity
 * (`audit.orderActivity`) with a category filter. Both use opaque cursors and the server's projection: customers
 * never receive staff identities, internal notes, former order names, addresses or internal ids.
 */
import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowRight, History, ListChecks } from "lucide-react";
import { Badge, DateTime, EmptyState, ErrorState, Field, LoadMore, Section, Select, Skeleton } from "@/ui";
import { useTRPC } from "@/lib/trpc";
import type { OrderActivityCategory, OrderActivityCustomerItem, OrderActivityStaffItem, OrderStatusHistoryItem } from "@server/modules/audit/index";

export interface OrderHistoryTabProps {
  orderId: string;
  area: "customer" | "console";
}

const CATEGORY_LABELS: Record<OrderActivityCategory, string> = {
  details: "Order details",
  status: "Status",
  access: "Sharing and access",
  phases: "Phases and locks",
  acceptance: "Policy acceptance",
  files: "Files",
  storage: "Storage sync",
  production: "Production",
  automation: "Automations",
  payments: "Payments",
  other: "Other",
};
/** Categories with customer-visible catalogue entries (server/modules/audit/orderActivity.ts). */
const CUSTOMER_CATEGORIES: OrderActivityCategory[] = ["details", "status", "access", "phases", "acceptance", "files", "payments"];

export default function OrderHistoryTab({ orderId, area }: OrderHistoryTabProps) {
  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-2">
      <StatusHistory orderId={orderId} />
      <ActivityFeed orderId={orderId} area={area} />
    </div>
  );
}

function StatusHistory({ orderId }: { orderId: string }) {
  const trpc = useTRPC();
  const list = useInfiniteQuery(
    trpc.audit.orderStatusHistory.infiniteQueryOptions({ orderPublicId: orderId, limit: 25 }, { getNextPageParam: (page) => page.nextCursor ?? undefined }),
  );
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Section title="Status history" description="Status changes and renames, newest first." className="min-w-0">
      {list.isPending ? (
        <Skeleton className="h-32" />
      ) : list.isError ? (
        <ErrorState title="Status history could not be loaded" error={list.error} onRetry={() => list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState headingLevel={3} icon={History} title="No status changes yet" description="Status changes appear here as the order moves forward." />
      ) : (
        <>
          <ol className="divide-y divide-line rounded-lg border border-line" aria-label="Status history entries">
            {items.map((item) => <StatusEntry key={item.key} item={item} />)}
          </ol>
          <LoadMore
            hasMore={Boolean(list.hasNextPage)}
            loading={list.isFetchingNextPage}
            onLoadMore={() => list.fetchNextPage()}
            summary={`Showing ${items.length} entr${items.length === 1 ? "y" : "ies"}`}
            label="Load more status history"
          />
        </>
      )}
    </Section>
  );
}

function StatusEntry({ item }: { item: OrderStatusHistoryItem }) {
  return (
    <li className="min-w-0 space-y-1 p-3">
      {item.kind === "rename" ? (
        <p className="break-words text-sm font-medium text-ink">
          {item.oldName && item.newName ? (
            <>
              Renamed: <span className="font-normal">{item.oldName}</span>
              <ArrowRight aria-hidden="true" className="mx-1 inline size-4" />
              <span className="sr-only">to </span>
              <span className="font-normal">{item.newName}</span>
            </>
          ) : (
            "Order renamed"
          )}
        </p>
      ) : (
        <p className="flex flex-wrap items-center gap-1 text-sm font-medium text-ink">
          {item.fromLabel ? (
            <>
              <span className="sr-only">Status changed from </span>
              <Badge>{item.fromLabel}</Badge>
              <ArrowRight aria-hidden="true" className="size-4 text-muted" />
              <span className="sr-only">to </span>
            </>
          ) : (
            <span>Order started as </span>
          )}
          <Badge tone="brand">{item.toLabel ?? item.to}</Badge>
        </p>
      )}
      {item.note ? <p className="break-words whitespace-pre-line text-sm text-ink">{item.note}</p> : null}
      <p className="text-xs text-muted">
        {item.actor} · <DateTime value={item.at} />
      </p>
    </li>
  );
}

function ActivityFeed({ orderId, area }: OrderHistoryTabProps) {
  const trpc = useTRPC();
  const [category, setCategory] = useState<OrderActivityCategory | "">("");
  const categories = area === "customer" ? CUSTOMER_CATEGORIES : (Object.keys(CATEGORY_LABELS) as OrderActivityCategory[]);
  const list = useInfiniteQuery(
    trpc.audit.orderActivity.infiniteQueryOptions(
      { orderPublicId: orderId, limit: 25, ...(category ? { category } : {}) },
      { getNextPageParam: (page) => page.nextCursor ?? undefined },
    ),
  );
  const pages = list.data?.pages ?? [];
  const staffView = pages[0]?.view === "staff";
  const items: (OrderActivityCustomerItem | OrderActivityStaffItem)[] = pages.flatMap((page): (OrderActivityCustomerItem | OrderActivityStaffItem)[] => page.items);
  return (
    <Section title="Activity" description="Recorded actions on this order, newest first." className="min-w-0">
      <Field label="Show">
        <Select
          value={category}
          onChange={(event) => setCategory(event.target.value as OrderActivityCategory | "")}
          options={[{ value: "", label: "All activity" }, ...categories.map((key) => ({ value: key, label: CATEGORY_LABELS[key] }))]}
        />
      </Field>
      {list.isPending ? (
        <Skeleton className="mt-3 h-32" />
      ) : list.isError ? (
        <ErrorState title="Activity could not be loaded" error={list.error} onRetry={() => list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState headingLevel={3} icon={ListChecks} title="No activity" description={category ? "Nothing recorded in this category yet." : "Nothing has been recorded for this order yet."} />
      ) : (
        <>
          <ol className="mt-3 divide-y divide-line rounded-lg border border-line" aria-label="Activity entries">
            {items.map((item) => (
              <li key={item.key} className="min-w-0 space-y-1 p-3">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                  <span className="break-words">{item.label}</span>
                  <Badge>{CATEGORY_LABELS[item.category]}</Badge>
                  {"outcome" in item && item.outcome !== "succeeded" && item.outcome !== "completed" ? <Badge tone="warning">Outcome: {item.outcome}</Badge> : null}
                </p>
                <p className="text-xs text-muted">
                  {item.actor}
                  {"actorRole" in item ? ` (${item.actorRole})` : ""} · <DateTime value={item.at} />
                </p>
                {staffView && "eventName" in item ? (
                  <details className="text-xs text-muted">
                    <summary className="cursor-pointer">Event details</summary>
                    <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 break-all">
                      <dt>Event</dt><dd>{item.eventName}</dd>
                      {item.reasonCode ? (<><dt>Reason</dt><dd>{item.reasonCode}</dd></>) : null}
                      {item.correlationId ? (<><dt>Correlation</dt><dd>{item.correlationId}</dd></>) : null}
                      {Object.entries(item.details).map(([key, value]) => (
                        <DetailRow key={key} name={key} value={value} />
                      ))}
                    </dl>
                  </details>
                ) : Object.keys(item.details).length ? (
                  <p className="text-xs text-muted">{Object.values(item.details).join(" · ")}</p>
                ) : null}
              </li>
            ))}
          </ol>
          <LoadMore
            hasMore={Boolean(list.hasNextPage)}
            loading={list.isFetchingNextPage}
            onLoadMore={() => list.fetchNextPage()}
            summary={`Showing ${items.length} activit${items.length === 1 ? "y" : "ies"}`}
            label="Load more activity"
          />
        </>
      )}
    </Section>
  );
}

function DetailRow({ name, value }: { name: string; value: string | number | boolean | null }) {
  return (
    <>
      <dt>{name.replaceAll("_", " ")}</dt>
      <dd>{value === null ? "—" : String(value)}</dd>
    </>
  );
}
