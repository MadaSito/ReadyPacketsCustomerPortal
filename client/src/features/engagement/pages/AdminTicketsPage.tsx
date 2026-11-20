import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { LifeBuoy } from "lucide-react";
import { Link } from "wouter";
import type { TicketCategory, TicketPriority, TicketStatus } from "@server/modules/engagement/types";
import { useTRPC } from "@/lib/trpc";
import {
  Badge,
  Card,
  DataTable,
  DateTime,
  EmptyState,
  ErrorState,
  Field,
  FilterBar,
  LoadMore,
  PageHeader,
  Select,
  Skeleton,
} from "@/ui";
import {
  TICKET_CATEGORY_OPTIONS,
  TICKET_PRIORITY_OPTIONS,
  TICKET_STATUS_FILTER_OPTIONS,
  TicketCategoryBadge,
  TicketPriorityBadge,
  TicketStatusBadge,
} from "../helpers";

export default function AdminTicketsPage() {
  const trpc = useTRPC();

  const [statusFilter, setStatusFilter] = useState<TicketStatus | "">("");
  const [priorityFilter, setPriorityFilter] = useState<TicketPriority | "">("");
  const [categoryFilter, setCategoryFilter] = useState<TicketCategory | "">("");
  const [assignmentFilter, setAssignmentFilter] = useState<"all" | "mine" | "unassigned">("all");
  const [searchInput, setSearchInput] = useState("");
  const [searchText, setSearchText] = useState("");

  const summaryQuery = useQuery(trpc.engagement.tickets.admin.queueSummary.queryOptions({}));

  const listQuery = useInfiniteQuery(
    trpc.engagement.tickets.admin.list.infiniteQueryOptions(
      {
        status: statusFilter || undefined,
        priority: priorityFilter || undefined,
        category: categoryFilter || undefined,
        assignedToMe: assignmentFilter === "mine" ? true : undefined,
        unassignedOnly: assignmentFilter === "unassigned" ? true : undefined,
        limit: 25,
      },
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

  const activeCount =
    (statusFilter ? 1 : 0) +
    (priorityFilter ? 1 : 0) +
    (categoryFilter ? 1 : 0) +
    (assignmentFilter !== "all" ? 1 : 0) +
    (searchText ? 1 : 0);
  const initialError =
    !listQuery.data && listQuery.isError
      ? (listQuery.error ?? new Error("Unable to load support queue."))
      : undefined;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Support queue"
        description="Triage, assign, and respond to customer support tickets."
      />

      {summaryQuery.isPending ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3" aria-label="Loading queue summary">
          <Card><Skeleton lines={2} /></Card>
          <Card><Skeleton lines={2} /></Card>
          <Card><Skeleton lines={2} /></Card>
        </div>
      ) : summaryQuery.isError && !initialError ? (
        <ErrorState
          error={summaryQuery.error}
          onRetry={() => {
            void summaryQuery.refetch();
          }}
        />
      ) : summaryQuery.data ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Card>
            <p className="text-xs font-medium text-muted">Active open</p>
            <p className="mt-1 text-2xl font-semibold text-ink">{summaryQuery.data.openCount}</p>
          </Card>
          <Card>
            <p className="text-xs font-medium text-muted">Unassigned</p>
            <p className="mt-1 text-2xl font-semibold text-ink">{summaryQuery.data.unassignedCount}</p>
          </Card>
          <Card>
            <p className="text-xs font-medium text-muted">Assigned to me</p>
            <p className="mt-1 text-2xl font-semibold text-ink">{summaryQuery.data.assignedToMeCount}</p>
          </Card>
        </div>
      ) : null}

      <FilterBar
        search={searchInput}
        onSearchChange={setSearchInput}
        onSearchSubmit={setSearchText}
        searchLabel="Filter queue"
        activeCount={activeCount}
        onReset={() => {
          setStatusFilter("");
          setPriorityFilter("");
          setCategoryFilter("");
          setAssignmentFilter("all");
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
        <Field label="Priority">
          <Select
            value={priorityFilter}
            onChange={(event) => setPriorityFilter(event.target.value as TicketPriority | "")}
            options={[{ value: "", label: "All priorities" }, ...TICKET_PRIORITY_OPTIONS]}
          />
        </Field>
        <Field label="Category">
          <Select
            value={categoryFilter}
            onChange={(event) => setCategoryFilter(event.target.value as TicketCategory | "")}
            options={[{ value: "", label: "All categories" }, ...TICKET_CATEGORY_OPTIONS]}
          />
        </Field>
        <Field label="Assignment">
          <Select
            value={assignmentFilter}
            onChange={(event) =>
              setAssignmentFilter(event.target.value as "all" | "mine" | "unassigned")
            }
            options={[
              { value: "all", label: "All tickets" },
              { value: "unassigned", label: "Unassigned only" },
              { value: "mine", label: "Assigned to me" },
            ]}
          />
        </Field>
      </FilterBar>

      <DataTable
        caption="Support ticket queue"
        rows={rows}
        loading={listQuery.isPending}
        error={initialError}
        onRetry={() => {
          void listQuery.refetch();
          if (summaryQuery.isError) void summaryQuery.refetch();
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
                  href={`/admin/tickets/${row.publicId}`}
                  className="font-semibold break-words text-action underline-offset-2 hover:underline"
                >
                  {row.ticketNumber} — {row.subject}
                </Link>
                <span className="text-xs text-muted">
                  Customer {row.requesterUserPublicId.slice(-8)}
                  {row.relatedOrderReference ? ` · Order ${row.relatedOrderReference}` : ""}
                </span>
              </div>
            ),
          },
          {
            key: "status",
            header: "Status",
            cell: (row) => <TicketStatusBadge status={row.status} staffView />,
          },
          {
            key: "priority",
            header: "Priority",
            cell: (row) => <TicketPriorityBadge priority={row.priority} />,
          },
          {
            key: "category",
            header: "Category",
            hideOnMobile: true,
            cell: (row) => <TicketCategoryBadge category={row.category} />,
          },
          {
            key: "assignee",
            header: "Assignee",
            hideOnMobile: true,
            cell: (row) =>
              row.assigneeUserPublicId ? (
                <Badge tone="info">Staff {row.assigneeUserPublicId.slice(-6)}</Badge>
              ) : (
                <Badge tone="warning">Unassigned</Badge>
              ),
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
            title="No tickets match the current filters"
            description="Reset filters or check back when new customer inquiries arrive."
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
