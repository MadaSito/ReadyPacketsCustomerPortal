/** Console invoices list (/admin/invoices) with status/order filters. Owner: orders_engineer (compliance admin UI). */
import { useInfiniteQuery } from "@tanstack/react-query";
import { Building2, Plus, Receipt } from "lucide-react";
import { useState } from "react";
import { Link, useSearch } from "wouter";
import { useTRPC } from "@/lib/trpc";
import { Button, Callout, DataTable, DateTime, EmptyState, Field, FilterBar, LoadMore, Money, PageHeader, Select } from "@/ui";
import { CompanyProfileDialog } from "../receipts/ReceiptViews";
import { InvoiceStatusBadge, type InvoiceStatus } from "../shared";
import { useCan } from "./common";
import { InvoiceEditor } from "./InvoiceEditor";
import { ULID, money, type InvoiceSummary } from "./model";

const STATUS_OPTIONS: { value: InvoiceStatus; label: string }[] = [
  { value: "draft", label: "Draft" },
  { value: "issued", label: "Issued (unpaid or part paid)" },
  { value: "paid", label: "Paid" },
  { value: "void", label: "Void" },
];

export default function InvoicesAdminPage() {
  const trpc = useTRPC();
  const canManage = useCan("invoices.manage");
  const initialOrder = new URLSearchParams(useSearch()).get("order") ?? "";
  const [status, setStatus] = useState<InvoiceStatus | "">("");
  const [orderInput, setOrderInput] = useState(initialOrder);
  const [orderId, setOrderId] = useState(ULID.test(initialOrder) ? initialOrder : "");
  const [orderError, setOrderError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  const list = useInfiniteQuery(
    trpc.compliance.invoices.admin.list.infiniteQueryOptions({ status: status || undefined, orderPublicId: orderId || undefined, limit: 25 }, { getNextPageParam: (page) => page.nextCursor ?? undefined }),
  );
  const rows = list.data?.pages.flatMap((page) => page.items);
  const filtered = Boolean(status || orderId);
  return (
    <>
      <PageHeader
        title="Invoices"
        description="Create and issue invoices for orders and record payments received outside the portal. Online payments and refunds are handled from the order's Refund tab and Payments settings."
        actions={
          canManage ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" leadingIcon={<Building2 aria-hidden />} onClick={() => setEditingProfile(true)}>
                Company profile
              </Button>
              <Button leadingIcon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
                New invoice
              </Button>
            </div>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-4">
        <FilterBar
          search={orderInput}
          onSearchChange={setOrderInput}
          onSearchSubmit={(value) => {
            const trimmed = value.trim();
            if (trimmed && !ULID.test(trimmed)) return setOrderError("An order ID is 26 characters, from the order page.");
            setOrderError(null);
            setOrderId(trimmed);
          }}
          searchLabel="Order ID"
          searchPlaceholder="26-character order ID"
          activeCount={(status ? 1 : 0) + (orderId ? 1 : 0)}
          onReset={() => {
            setStatus("");
            setOrderInput("");
            setOrderId("");
            setOrderError(null);
          }}
        >
          <Field label="Status">
            <Select options={STATUS_OPTIONS} placeholder="All statuses" value={status} onChange={(e) => setStatus(e.target.value as InvoiceStatus | "")} />
          </Field>
        </FilterBar>
        {orderError ? <Callout tone="danger" live="assertive">{orderError}</Callout> : null}
        <DataTable<InvoiceSummary>
          caption="Invoices"
          rows={rows}
          loading={list.isPending}
          error={list.error}
          onRetry={() => void list.refetch()}
          rowKey={(row) => row.invoicePublicId}
          columns={[
            {
              key: "number",
              header: "Invoice",
              primary: true,
              cell: (row) => (
                <Link href={`/admin/invoices/${row.invoicePublicId}`} className="inline-flex min-h-6 items-center py-0.5 font-semibold break-all text-action underline-offset-2 hover:underline">
                  {row.invoiceNumber ?? "Draft invoice"}
                  {row.invoiceNumber ? null : <span className="sr-only">{` for ${row.orderReference}`}</span>}
                </Link>
              ),
            },
            { key: "order", header: "Order", cell: (row) => <span className="font-mono break-all">{row.orderReference}</span> },
            {
              key: "project",
              header: "Project",
              cell: (row) =>
                row.projectName?.trim() ? (
                  <span className="break-words">{row.projectName.trim()}</span>
                ) : (
                  <span className="text-muted">—</span>
                ),
            },
            { key: "status", header: "Status", cell: (row) => <InvoiceStatusBadge status={row.status} /> },
            { key: "total", header: "Total", align: "end", cell: (row) => <Money value={money(row.totalMinor, row.currency)} /> },
            { key: "balance", header: "Balance due", align: "end", cell: (row) => <Money value={money(row.balanceDueMinor, row.currency)} /> },
            { key: "issued", header: "Issued", hideOnMobile: true, cell: (row) => <DateTime value={row.issuedAt} format="date" /> },
            { key: "due", header: "Due", cell: (row) => <DateTime value={row.dueAt} format="date" /> },
          ]}
          empty={
            <EmptyState
              icon={Receipt}
              headingLevel={3}
              title={filtered ? "No invoices match these filters" : "No invoices yet"}
              description={filtered ? "Try another status or clear the filters." : "Create a draft invoice for an order, then issue it to the customer."}
              action={
                !filtered && canManage ? (
                  <Button onClick={() => setCreating(true)}>Create the first invoice</Button>
                ) : orderId && !status && canManage ? (
                  <Button onClick={() => setCreating(true)}>New invoice for this order</Button>
                ) : undefined
              }
            />
          }
        />
        {rows ? <LoadMore hasMore={Boolean(list.hasNextPage)} loading={list.isFetchingNextPage} onLoadMore={() => void list.fetchNextPage()} summary={`Showing ${rows.length} invoices`} /> : null}
      </div>
      {creating ? <InvoiceEditor invoice={null} defaultOrderId={orderId} onClose={() => setCreating(false)} /> : null}
      {editingProfile ? <CompanyProfileDialog onClose={() => setEditingProfile(false)} /> : null}
    </>
  );
}
