/** Console order list (/admin/orders) with filters and cursor pagination. Owner: orders_engineer. */
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Package } from "lucide-react";
import { useState } from "react";
import { Link, useSearch } from "wouter";
import { useSession } from "@/lib/session";
import { useTRPC } from "@/lib/trpc";
import { Button, DataTable, DateTime, EmptyState, Field, FilterBar, Input, LoadMore, Money, PageHeader, Select } from "@/ui";
import { NewOrderForCustomerButton } from "../ConsoleOrderTools";
import { LOCK_LABELS, LockBadge, OrderStatusBadge, money, type LockState } from "../shared";
import { OrderListProgress } from "../stages/OrderListProgress";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const STATUS_KEY = /^[a-z][a-z0-9_]{1,47}$/;

type AttentionFilter = "" | "staff_review" | "customer_response";
type Filters = {
  referencePrefix: string;
  status: string;
  lockState: string;
  customerPublicId: string;
  from: string;
  to: string;
  attention: AttentionFilter;
};
const EMPTY: Filters = { referencePrefix: "", status: "", lockState: "", customerPublicId: "", from: "", to: "", attention: "" };

function toInput(filters: Filters) {
  const ref = filters.referencePrefix.trim();
  return {
    limit: 25,
    referencePrefix: /^[A-Za-z0-9-]{1,32}$/.test(ref) ? ref : undefined,
    status: STATUS_KEY.test(filters.status) ? filters.status : undefined,
    lockState: filters.lockState ? (filters.lockState as LockState) : undefined,
    customerPublicId: ULID.test(filters.customerPublicId.trim()) ? filters.customerPublicId.trim() : undefined,
    from: filters.from ? new Date(`${filters.from}T00:00:00`) : undefined,
    to: filters.to ? new Date(`${filters.to}T23:59:59.999`) : undefined,
    attention: filters.attention === "staff_review" || filters.attention === "customer_response" ? filters.attention : undefined,
  };
}

export default function AdminOrdersPage() {
  const trpc = useTRPC();
  const { me } = useSession();
  const search = useSearch();
  // Deep links such as /admin/orders?status=in_review or /admin/orders?attention=staff_review pre-select filters.
  const [draft, setDraft] = useState<Filters>(() => {
    const params = new URLSearchParams(search);
    const status = params.get("status") ?? "";
    const attention = params.get("attention") ?? "";
    return {
      ...EMPTY,
      status: STATUS_KEY.test(status) ? status : "",
      attention: attention === "staff_review" || attention === "customer_response" ? attention : "",
    };
  });
  // Filter controls apply immediately; the reference search applies on submit.
  const [appliedRef, setAppliedRef] = useState("");
  const applied: Filters = { ...draft, referencePrefix: appliedRef };
  const statusCatalog = useQuery(trpc.orders.statusCatalog.list.queryOptions({ includeRetired: true }, { retry: false }));
  const attentionCounts = useQuery(trpc.orders.statusCatalog.attentionCounts.queryOptions(undefined, { retry: false }));
  const workflows = useQuery(trpc.orders.admin.workflows.list.queryOptions(undefined, { enabled: me?.user.role === "admin", retry: false }));
  const list = useInfiniteQuery(trpc.orders.admin.list.infiniteQueryOptions(toInput(applied), { getNextPageParam: (page) => page.nextCursor ?? undefined }));
  const rows = list.data?.pages.flatMap((page) => page.items);
  const catalogEntries = (statusCatalog.data ?? []).map((item) => ({
    key: item.key,
    label: item.retired ? `${item.staffLabel} (retired)` : item.staffLabel,
  }));
  const workflowEntries = (workflows.data ?? [])
    .flatMap((wf) => wf.definition?.states ?? [])
    .map((state) => ({ key: state.key, label: state.label }));
  const statusOptions = [...catalogEntries, ...workflowEntries]
    .filter((entry, index, all) => all.findIndex((candidate) => candidate.key === entry.key) === index)
    .map((entry) => ({ value: entry.key, label: entry.label }));
  const activeCount = Object.values(applied).filter((value) => value !== "").length - (applied.referencePrefix ? 1 : 0);
  const set = (key: keyof Filters) => (event: { target: { value: string } }) => setDraft((current) => ({ ...current, [key]: event.target.value }));

  return (
    <>
      <PageHeader title="Orders" description="Every customer order. Filter by attention, reference, status, lock, customer or date." actions={<NewOrderForCustomerButton />} />
      <div className="flex flex-col gap-6">
        <div role="group" aria-label="Filter orders by attention" className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={draft.attention === "" ? "primary" : "secondary"}
            aria-pressed={draft.attention === ""}
            onClick={() => setDraft((current) => ({ ...current, attention: "" }))}
          >
            All orders
          </Button>
          <Button
            size="sm"
            variant={draft.attention === "staff_review" ? "primary" : "secondary"}
            aria-pressed={draft.attention === "staff_review"}
            onClick={() => setDraft((current) => ({ ...current, attention: "staff_review" }))}
          >
            {attentionCounts.data ? `Awaiting staff review (${attentionCounts.data.staffReview})` : "Awaiting staff review"}
          </Button>
          <Button
            size="sm"
            variant={draft.attention === "customer_response" ? "primary" : "secondary"}
            aria-pressed={draft.attention === "customer_response"}
            onClick={() => setDraft((current) => ({ ...current, attention: "customer_response" }))}
          >
            {attentionCounts.data ? `Awaiting customer response (${attentionCounts.data.customerResponse})` : "Awaiting customer response"}
          </Button>
        </div>
        <FilterBar
          search={draft.referencePrefix}
          onSearchChange={(value) => setDraft((current) => ({ ...current, referencePrefix: value }))}
          onSearchSubmit={(value) => setAppliedRef(value)}
          searchLabel="Reference starts with"
          activeCount={Math.max(activeCount, 0)}
          onReset={() => (setDraft(EMPTY), setAppliedRef(""))}
          actions={null}
        >
          {statusOptions.length > 0 ? (
            <Field label="Status">
              <Select options={statusOptions} placeholder="Any status" value={draft.status} onChange={set("status")} />
            </Field>
          ) : (
            <Field label="Status key" hint="For example in_review.">
              <Input value={draft.status} onChange={set("status")} maxLength={48} autoComplete="off" spellCheck={false} />
            </Field>
          )}
          <Field label="Lock">
            <Select options={(Object.keys(LOCK_LABELS) as LockState[]).map((s) => ({ value: s, label: LOCK_LABELS[s] }))} placeholder="Any" value={draft.lockState} onChange={set("lockState")} />
          </Field>
          <Field label="Customer ID">
            <Input value={draft.customerPublicId} onChange={set("customerPublicId")} maxLength={26} autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="Created from">
            <Input type="date" value={draft.from} onChange={set("from")} />
          </Field>
          <Field label="Created to">
            <Input type="date" value={draft.to} onChange={set("to")} />
          </Field>
        </FilterBar>
        <DataTable
          caption="Customer orders"
          rows={rows}
          loading={list.isPending}
          error={list.error}
          onRetry={() => void list.refetch()}
          rowKey={(order) => order.publicId}
          columns={[
            {
              key: "reference",
              header: "Reference",
              primary: true,
              cell: (order) => (
                <Link href={`/admin/orders/${order.publicId}`} className="font-semibold whitespace-nowrap text-action underline-offset-2 hover:underline">
                  {order.reference}
                </Link>
              ),
            },
            { key: "project", header: "Project", cell: (order) => <span className="break-words">{order.projectName}</span> },
            { key: "customer", header: "Customer", hideOnMobile: true, cell: (order) => <span className="break-words">{order.ownerName ?? "—"}</span> },
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
            {
              key: "phase",
              header: "Phase",
              hideOnMobile: true,
              // Increment 07 QA: the compact bar alone (its visible line already names the position and the phase);
              // the plain text only when there is no progress value yet. "—" without a phase model.
              cell: (order) =>
                order.phaseLabel && order.phaseIndex !== null && order.phaseTotal ? (
                  <div className="min-w-[9rem]">
                    {order.progressPercent === null || order.progressPercent === undefined ? (
                      <span className="text-sm break-words text-ink">{`Step ${order.phaseIndex + 1} of ${order.phaseTotal}: ${order.phaseLabel}`}</span>
                    ) : (
                      <OrderListProgress
                        name={order.reference}
                        progressPercent={order.progressPercent}
                        phaseLabel={order.phaseLabel}
                        phaseIndex={order.phaseIndex}
                        phaseTotal={order.phaseTotal}
                        canceled={order.progressCanceled}
                      />
                    )}
                  </div>
                ) : (
                  <span className="text-muted">—</span>
                ),
            },
            { key: "createdAt", header: "Created", hideOnMobile: true, cell: (order) => <DateTime value={order.createdAt} format="date" /> },
            { key: "total", header: "Total", align: "end", cell: (order) => <Money value={money(order.totalMinor, order.currency)} /> },
          ]}
          empty={<EmptyState icon={Package} title="No orders match" description="Adjust or reset the filters." />}
        />
        <LoadMore hasMore={!!list.hasNextPage} loading={list.isFetchingNextPage} onLoadMore={() => void list.fetchNextPage()} summary={rows ? `Showing ${rows.length} orders` : undefined} />
      </div>
    </>
  );
}
