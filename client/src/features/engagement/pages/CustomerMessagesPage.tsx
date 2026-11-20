import { useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCheck, MessageSquare, Package } from "lucide-react";
import { Link } from "wouter";
import { errorMessage, useTRPC } from "@/lib/trpc";
import {
  Badge,
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
  useToast,
} from "@/ui";

export default function CustomerMessagesPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [searchInput, setSearchInput] = useState("");
  const [searchFilter, setSearchFilter] = useState("");
  const [unreadFilter, setUnreadFilter] = useState<"all" | "unread">("all");

  const threadsQuery = useInfiniteQuery(
    trpc.engagement.messages.threads.infiniteQueryOptions(
      { unreadOnly: unreadFilter === "unread", limit: 25 },
      { getNextPageParam: (lastPage) => lastPage.nextCursor },
    ),
  );

  const markAllRead = useMutation(
    trpc.engagement.messages.markAllRead.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.engagement.messages.pathKey() });
        toast.show({ tone: "success", title: "All order messages marked as read" });
      },
      onError: (err) =>
        toast.show({
          tone: "danger",
          title: "Could not mark messages read",
          description: errorMessage(err),
        }),
    }),
  );

  const allRows = threadsQuery.data ? threadsQuery.data.pages.flatMap((p) => p.items) : undefined;
  const rows =
    allRows === undefined
      ? undefined
      : searchFilter
        ? allRows.filter((row) => {
            const needle = searchFilter.toLowerCase();
            return (
              row.orderReference.toLowerCase().includes(needle) ||
              row.projectName.toLowerCase().includes(needle) ||
              row.lastMessagePreview.toLowerCase().includes(needle)
            );
          })
        : allRows;

  const totalUnread = (allRows ?? []).reduce((acc, row) => acc + row.unreadCount, 0);
  const activeCount = (unreadFilter === "unread" ? 1 : 0) + (searchFilter ? 1 : 0);
  const initialError =
    !threadsQuery.data && threadsQuery.isError
      ? (threadsQuery.error ?? new Error("Unable to load conversations."))
      : undefined;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Messages"
        description="Conversations with the ReadyPackets team across your orders."
        actions={
          totalUnread > 0 ? (
            <Button
              variant="secondary"
              leadingIcon={<CheckCheck aria-hidden="true" />}
              loading={markAllRead.isPending}
              onClick={() => markAllRead.mutate({})}
            >
              Mark all read
            </Button>
          ) : undefined
        }
      />

      <FilterBar
        search={searchInput}
        onSearchChange={setSearchInput}
        onSearchSubmit={setSearchFilter}
        searchLabel="Filter conversations"
        activeCount={activeCount}
        onReset={() => {
          setSearchInput("");
          setSearchFilter("");
          setUnreadFilter("all");
        }}
      >
        <Field label="Read status">
          <Select
            value={unreadFilter}
            onChange={(event) => setUnreadFilter(event.target.value as "all" | "unread")}
            options={[
              { value: "all", label: "All threads" },
              { value: "unread", label: "Unread only" },
            ]}
          />
        </Field>
      </FilterBar>

      <DataTable
        caption="Order message threads"
        rows={rows}
        loading={threadsQuery.isPending}
        error={initialError}
        onRetry={() => {
          void threadsQuery.refetch();
        }}
        rowKey={(row) => row.orderPublicId}
        columns={[
          {
            key: "order",
            header: "Order",
            primary: true,
            cell: (row) => (
              <div className="flex min-w-0 flex-col gap-0.5">
                <Link
                  href={`/orders/${row.orderPublicId}/messages`}
                  className="font-semibold text-action underline-offset-2 hover:underline"
                >
                  {row.orderReference}
                </Link>
                <span className="truncate text-sm text-muted">{row.projectName}</span>
              </div>
            ),
          },
          {
            key: "preview",
            header: "Latest message",
            cell: (row) => (
              <div className="min-w-0 max-w-md">
                <p className="line-clamp-2 break-words text-sm text-body">
                  {row.lastMessagePreview}
                </p>
                <span className="text-xs text-muted">
                  {row.lastAuthorRole === "customer" ? "You / collaborator" : "ReadyPackets team"}
                </span>
              </div>
            ),
          },
          {
            key: "unread",
            header: "Status",
            cell: (row) =>
              row.unreadCount > 0 ? (
                <Badge tone="brand">{row.unreadCount} unread</Badge>
              ) : (
                <Badge tone="neutral">Read</Badge>
              ),
          },
          {
            key: "lastMessageAt",
            header: "Updated",
            cell: (row) => <DateTime value={row.lastMessageAt} format="relative" />,
          },
        ]}
        empty={
          <EmptyState
            icon={MessageSquare}
            title={unreadFilter === "unread" ? "No unread order messages" : "No order conversations yet"}
            description="Open an order and switch to its Messages tab to start a conversation."
            action={
              <Button asChild variant="secondary" leadingIcon={<Package aria-hidden="true" />}>
                <Link href="/orders">View your orders</Link>
              </Button>
            }
          />
        }
      />

      {threadsQuery.data && threadsQuery.isError ? (
        <ErrorState
          error={threadsQuery.error}
          onRetry={() => {
            void threadsQuery.fetchNextPage();
          }}
        />
      ) : null}

      <LoadMore
        hasMore={!!threadsQuery.hasNextPage}
        loading={threadsQuery.isFetchingNextPage}
        onLoadMore={() => threadsQuery.fetchNextPage()}
        summary={rows && rows.length > 0 ? `Showing ${rows.length} conversation${rows.length === 1 ? "" : "s"}` : undefined}
      />
    </div>
  );
}
