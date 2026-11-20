import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { EyeOff, MessageSquare } from "lucide-react";
import { Link } from "wouter";
import { useTRPC } from "@/lib/trpc";
import {
  Badge,
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

export default function AdminMessagesPage() {
  const trpc = useTRPC();

  const [unreadOnly, setUnreadOnly] = useState(false);
  const [visibility, setVisibility] = useState<"" | "customer" | "internal">("");
  const [searchInput, setSearchInput] = useState("");
  const [searchText, setSearchText] = useState("");

  const inboxQuery = useInfiniteQuery(
    trpc.engagement.messages.adminInbox.infiniteQueryOptions(
      {
        unreadOnly: unreadOnly || undefined,
        visibility: visibility || undefined,
        limit: 25,
      },
      { getNextPageParam: (lastPage) => lastPage.nextCursor },
    ),
  );

  const allItems = inboxQuery.data ? inboxQuery.data.pages.flatMap((p) => p.items) : undefined;
  const rows =
    allItems === undefined
      ? undefined
      : searchText
        ? allItems.filter((item) => {
            const needle = searchText.toLowerCase();
            return (
              item.orderReference.toLowerCase().includes(needle) ||
              item.body.toLowerCase().includes(needle) ||
              item.authorDisplayLabel.toLowerCase().includes(needle)
            );
          })
        : allItems;

  const activeCount = (unreadOnly ? 1 : 0) + (visibility ? 1 : 0) + (searchText ? 1 : 0);
  const initialError =
    !inboxQuery.data && inboxQuery.isError
      ? (inboxQuery.error ?? new Error("Unable to load order messages."))
      : undefined;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Order message inbox"
        description="Review recent customer messages and internal staff notes across orders."
      />

      <FilterBar
        search={searchInput}
        onSearchChange={setSearchInput}
        onSearchSubmit={setSearchText}
        searchLabel="Filter messages"
        activeCount={activeCount}
        onReset={() => {
          setUnreadOnly(false);
          setVisibility("");
          setSearchInput("");
          setSearchText("");
        }}
      >
        <Field label="Read state">
          <Select
            value={unreadOnly ? "unread" : "all"}
            onChange={(event) => setUnreadOnly(event.target.value === "unread")}
            options={[
              { value: "all", label: "All messages" },
              { value: "unread", label: "Unread by me" },
            ]}
          />
        </Field>
        <Field label="Visibility">
          <Select
            value={visibility}
            onChange={(event) => setVisibility(event.target.value as "" | "customer" | "internal")}
            options={[
              { value: "", label: "Customer & internal" },
              { value: "customer", label: "Customer messages" },
              { value: "internal", label: "Internal notes only" },
            ]}
          />
        </Field>
      </FilterBar>

      <DataTable
        caption="Staff order messages inbox"
        rows={rows}
        loading={inboxQuery.isPending}
        error={initialError}
        onRetry={() => {
          void inboxQuery.refetch();
        }}
        rowKey={(row) => row.publicId}
        columns={[
          {
            key: "order",
            header: "Order",
            primary: true,
            cell: (row) => (
              <Link
                href={`/admin/orders/${row.orderPublicId}/messages`}
                className="font-semibold text-action underline-offset-2 hover:underline"
              >
                {row.orderReference}
              </Link>
            ),
          },
          {
            key: "author",
            header: "Author",
            cell: (row) => (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium text-ink">{row.authorDisplayLabel}</span>
                <Badge tone={row.authorRole === "customer" ? "neutral" : "info"}>
                  {row.authorRole}
                </Badge>
              </div>
            ),
          },
          {
            key: "preview",
            header: "Message",
            cell: (row) => (
              <p className="max-w-md line-clamp-2 break-words text-sm text-body">
                {row.body}
              </p>
            ),
          },
          {
            key: "visibility",
            header: "Type",
            cell: (row) => (
              <div className="flex flex-wrap items-center gap-1.5">
                {row.visibility === "internal" ? (
                  <Badge tone="warning" icon={<EyeOff aria-hidden="true" />}>
                    Internal
                  </Badge>
                ) : (
                  <Badge tone="neutral">Customer</Badge>
                )}
                {row.unread ? <Badge tone="brand">Unread</Badge> : null}
              </div>
            ),
          },
          {
            key: "createdAt",
            header: "Received",
            cell: (row) => <DateTime value={row.createdAt} format="relative" />,
          },
        ]}
        empty={
          <EmptyState
            icon={MessageSquare}
            title="No messages match these filters"
            description="Customer order messages and staff internal notes will appear here."
          />
        }
      />

      {inboxQuery.data && inboxQuery.isError ? (
        <ErrorState
          error={inboxQuery.error}
          onRetry={() => {
            void inboxQuery.fetchNextPage();
          }}
        />
      ) : null}

      <LoadMore
        hasMore={!!inboxQuery.hasNextPage}
        loading={inboxQuery.isFetchingNextPage}
        onLoadMore={() => inboxQuery.fetchNextPage()}
        summary={rows && rows.length > 0 ? `Showing ${rows.length} message${rows.length === 1 ? "" : "s"}` : undefined}
      />
    </div>
  );
}
