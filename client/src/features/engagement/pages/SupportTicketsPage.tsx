import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { LifeBuoy, Plus } from "lucide-react";
import { Link } from "wouter";
import type { TicketStatus } from "@server/modules/engagement/types";
import { useTRPC } from "@/lib/trpc";
import {
  Button,
  DataTable,
  DateTime,
  EmptyState,
  ErrorState,
  Field,
  FilterBar,
  LoadMore,
  PageHeader,
  Select,
} from "@/ui";
import {
  TICKET_STATUS_FILTER_OPTIONS,
  TicketCategoryBadge,
  TicketPriorityBadge,
  TicketStatusBadge,
} from "../helpers";

export default function SupportTicketsPage() {
  const trpc = useTRPC();
  const [statusFilter, setStatusFilter] = useState<TicketStatus | "">("");
  const [searchInput, setSearchInput] = useState("");
  const [searchText, setSearchText] = useState("");

  const listQuery = useInfiniteQuery(
    trpc.engagement.tickets.list.infiniteQueryOptions(
      { status: statusFilter || undefined, limit: 20 },
      { getNextPageParam: (lastPage) => lastPage.nextCursor },
    ),
  );

  const allItems = listQuery.data ? listQuery.data.pages.flatMap((p) => p.items) : undefined;
  const rows =
    allItems === undefined
      ? undefined
      : searchText
        ? allItems.filter((item) => {
            const needle = searchText.toLowerCase();
            return (
              item.ticketNumber.toLowerCase().includes(needle) ||
              item.subject.toLowerCase().includes(needle) ||
              (item.relatedOrderReference?.toLowerCase().includes(needle) ?? false)
            );
          })
        : allItems;

  const activeCount = (statusFilter ? 1 : 0) + (searchText ? 1 : 0);
  const initialError =
    !listQuery.data && listQuery.isError
      ? (listQuery.error ?? new Error("Unable to load support tickets."))
      : undefined;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Support tickets"
        description="Get help with an order, deliverable, billing question, or account issue."
        actions={
          <Button asChild leadingIcon={<Plus aria-hidden="true" />}>
            <Link href="/support/new">New support ticket</Link>
          </Button>
        }
      />

      <FilterBar
        search={searchInput}
        onSearchChange={setSearchInput}
        onSearchSubmit={setSearchText}
        searchLabel="Filter your tickets"
        activeCount={activeCount}
        onReset={() => {
          setStatusFilter("");
          setSearchInput("");
          setSearchText("");
        }}
      >
        <Field label="Status">
          <Select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as TicketStatus | "")}
            options={TICKET_STATUS_FILTER_OPTIONS}
          />
        </Field>
      </FilterBar>

      <DataTable
        caption="Your support tickets"
        rows={rows}
        loading={listQuery.isPending}
        error={initialError}
        onRetry={() => {
          void listQuery.refetch();
        }}
        rowKey={(row) => row.publicId}
        columns={[
          {
            key: "ticket",
            header: "Ticket",
            primary: true,
            cell: (row) => (
              <div className="flex min-w-0 flex-col gap-0.5">
                <Link
                  href={`/support/${row.publicId}`}
                  className="font-semibold break-words text-action underline-offset-2 hover:underline"
                >
                  {row.subject}
                </Link>
                <span className="text-xs text-muted">
                  {row.ticketNumber}
                  {row.relatedOrderReference ? ` · Order ${row.relatedOrderReference}` : ""}
                </span>
              </div>
            ),
          },
          {
            key: "category",
            header: "Category",
            hideOnMobile: true,
            cell: (row) => <TicketCategoryBadge category={row.category} />,
          },
          {
            key: "status",
            header: "Status",
            cell: (row) => <TicketStatusBadge status={row.status} />,
          },
          {
            key: "priority",
            header: "Priority",
            hideOnMobile: true,
            cell: (row) => <TicketPriorityBadge priority={row.priority} />,
          },
          {
            key: "updatedAt",
            header: "Updated",
            cell: (row) => <DateTime value={row.updatedAt} format="relative" />,
          },
        ]}
        empty={
          <EmptyState
            icon={LifeBuoy}
            title="No support tickets yet"
            description="Have a question or need assistance? Open a ticket and our support team will respond."
            action={
              <Button asChild leadingIcon={<Plus aria-hidden="true" />}>
                <Link href="/support/new">Open a support ticket</Link>
              </Button>
            }
          />
        }
      />

      {listQuery.data && listQuery.isError ? (
        <ErrorState
          error={listQuery.error}
          onRetry={() => {
            void listQuery.fetchNextPage();
          }}
        />
      ) : null}

      <LoadMore
        hasMore={!!listQuery.hasNextPage}
        loading={listQuery.isFetchingNextPage}
        onLoadMore={() => listQuery.fetchNextPage()}
        summary={rows && rows.length > 0 ? `Showing ${rows.length} ticket${rows.length === 1 ? "" : "s"}` : undefined}
      />
    </div>
  );
}
