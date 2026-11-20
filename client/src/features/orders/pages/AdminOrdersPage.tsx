/** Console order list (/admin/orders) with filters and cursor pagination. Owner: orders_engineer. */
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Package } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { useSession } from "@/lib/session";
import { useTRPC } from "@/lib/trpc";
import { DataTable, DateTime, EmptyState, Field, FilterBar, Input, LoadMore, Money, PageHeader, Select } from "@/ui";
import { LOCK_LABELS, LockBadge, OrderStatusBadge, money, type LockState } from "../shared";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const STATUS_KEY = /^[a-z][a-z0-9_]{1,47}$/;

type Filters = { referencePrefix: string; status: string; lockState: string; customerPublicId: string; from: string; to: string };
const EMPTY: Filters = { referencePrefix: "", status: "", lockState: "", customerPublicId: "", from: "", to: "" };

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
  };
}

export default function AdminOrdersPage() {
  const trpc = useTRPC();
  const { me } = useSession();
  const [draft, setDraft] = useState<Filters>(EMPTY);
  // Filter controls apply immediately; the reference search applies on submit.
  const [appliedRef, setAppliedRef] = useState("");
  const applied: Filters = { ...draft, referencePrefix: appliedRef };
  const workflows = useQuery(trpc.orders.admin.workflows.list.queryOptions(undefined, { enabled: me?.user.role === "admin", retry: false }));
  const list = useInfiniteQuery(trpc.orders.admin.list.infiniteQueryOptions(toInput(applied), { getNextPageParam: (page) => page.nextCursor ?? undefined }));
  const rows = list.data?.pages.flatMap((page) => page.items);
  const statusOptions = (workflows.data ?? [])
    .flatMap((wf) => wf.definition?.states ?? [])
    .filter((state, index, all) => all.findIndex((s) => s.key === state.key) === index)
    .map((state) => ({ value: state.key, label: state.label }));
  const activeCount = Object.values(applied).filter((value) => value !== "").length - (applied.referencePrefix ? 1 : 0);
  const set = (key: keyof Filters) => (event: { target: { value: string } }) => setDraft((current) => ({ ...current, [key]: event.target.value }));

  return (
    <>
      <PageHeader title="Orders" description="Every customer order. Filter by reference, status, lock, customer or date." />
      <div className="flex flex-col gap-6">
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
                <Link href={`/admin/orders/${order.publicId}`} className="font-semibold break-all text-action underline-offset-2 hover:underline">
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
