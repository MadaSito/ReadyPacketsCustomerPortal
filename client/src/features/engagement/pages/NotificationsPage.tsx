import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CheckCheck } from "lucide-react";
import { Link } from "wouter";
import type { NotificationPreferenceCategory } from "@server/modules/engagement/types";
import { errorMessage, useTRPC } from "@/lib/trpc";
import {
  Badge,
  Button,
  Card,
  DateTime,
  EmptyState,
  ErrorState,
  Field,
  LoadMore,
  PageHeader,
  Select,
  Skeleton,
  Switch,
  Tabs,
  useToast,
} from "@/ui";
import { NOTIFICATION_CATEGORY_INFO, safeInternalPath } from "../helpers";

export default function NotificationsPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [unreadFilter, setUnreadFilter] = useState<"all" | "unread">("all");

  const listQuery = useInfiniteQuery(
    trpc.engagement.notifications.list.infiniteQueryOptions(
      { unreadOnly: unreadFilter === "unread", limit: 25 },
      { getNextPageParam: (lastPage) => lastPage.nextCursor },
    ),
  );
  const unreadCountQuery = useQuery(trpc.engagement.notifications.unreadCount.queryOptions({}));
  const prefsQuery = useQuery(trpc.engagement.notifications.preferences.get.queryOptions({}));

  const invalidateNotifications = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.engagement.notifications.pathKey() });
  };

  const markReadMutation = useMutation(
    trpc.engagement.notifications.markRead.mutationOptions({
      onSuccess: invalidateNotifications,
      onError: (err) =>
        toast.show({
          tone: "danger",
          title: "Could not mark notification read",
          description: errorMessage(err),
        }),
    }),
  );

  const markAllReadMutation = useMutation(
    trpc.engagement.notifications.markAllRead.mutationOptions({
      onSuccess: () => {
        invalidateNotifications();
        toast.show({ tone: "success", title: "All notifications marked as read" });
      },
      onError: (err) =>
        toast.show({
          tone: "danger",
          title: "Could not mark notifications read",
          description: errorMessage(err),
        }),
    }),
  );

  const updatePrefMutation = useMutation(
    trpc.engagement.notifications.preferences.update.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.engagement.notifications.preferences.pathKey(),
        });
        toast.show({ tone: "success", title: "Notification preference updated" });
      },
      onError: (err) =>
        toast.show({
          tone: "danger",
          title: "Could not update preference",
          description: errorMessage(err),
        }),
    }),
  );

  const items = listQuery.data?.pages.flatMap((p) => p.items) ?? [];
  const unreadCount = unreadCountQuery.data?.unreadCount ?? 0;

  const activityContent = (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="w-full sm:w-56">
          <Field label="Filter notifications">
            <Select
              value={unreadFilter}
              onChange={(event) => setUnreadFilter(event.target.value as "all" | "unread")}
              options={[
                { value: "all", label: "All notifications" },
                { value: "unread", label: "Unread only" },
              ]}
            />
          </Field>
        </div>
      </div>

      {listQuery.isPending ? (
        <Skeleton lines={4} />
      ) : listQuery.error ? (
        <ErrorState error={listQuery.error} onRetry={() => listQuery.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Bell}
          title={unreadFilter === "unread" ? "No unread notifications" : "No notifications yet"}
          description="You will see updates here when orders progress, messages arrive, or tickets change."
        />
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Notifications list">
          {items.map((item) => {
            const isUnread = item.readAt === null;
            const safeHref = safeInternalPath(item.link);
            return (
              <li
                key={item.publicId}
                className="rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-[var(--shadow-card)]"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-ink">{item.title}</p>
                    <Badge tone="neutral">
                      {NOTIFICATION_CATEGORY_INFO[item.category as NotificationPreferenceCategory]?.label ??
                        item.category}
                    </Badge>
                    {isUnread ? <Badge tone="brand">Unread</Badge> : null}
                  </div>
                  <span className="text-xs text-muted">
                    <DateTime value={item.createdAt} format="datetime" />
                  </span>
                </div>

                <p className="mt-1.5 break-words whitespace-pre-wrap text-body">{item.body}</p>

                <div className="mt-3 flex flex-wrap items-center gap-3">
                  {safeHref ? (
                    <Button
                      asChild
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        if (isUnread) markReadMutation.mutate({ notificationId: item.publicId });
                      }}
                    >
                      <Link href={safeHref}>View details</Link>
                    </Button>
                  ) : null}
                  {isUnread ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => markReadMutation.mutate({ notificationId: item.publicId })}
                    >
                      Mark read
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <LoadMore
        hasMore={!!listQuery.hasNextPage}
        loading={listQuery.isFetchingNextPage}
        onLoadMore={() => listQuery.fetchNextPage()}
        summary={items.length > 0 ? `Showing ${items.length} notification${items.length === 1 ? "" : "s"}` : undefined}
      />
    </div>
  );

  const preferencesContent = prefsQuery.isPending ? (
    <Skeleton lines={5} />
  ) : prefsQuery.error ? (
    <ErrorState error={prefsQuery.error} onRetry={() => prefsQuery.refetch()} />
  ) : (
    <Card
      title="Delivery preferences"
      description="Choose how you receive alerts per category. Notification emails never include confidential message content."
    >
      <div className="flex flex-col divide-y divide-line">
        {(prefsQuery.data?.items ?? []).map((pref) => {
          const meta = NOTIFICATION_CATEGORY_INFO[pref.category];
          return (
            <div
              key={pref.category}
              className="flex flex-col gap-4 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="font-semibold text-ink">{meta.label}</p>
                <p className="text-sm text-muted">{meta.description}</p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-6">
                <Switch
                  label={`In-app (${meta.label})`}
                  checked={pref.inApp}
                  disabled={pref.inAppLocked || updatePrefMutation.isPending}
                  onCheckedChange={(checked) =>
                    updatePrefMutation.mutate({
                      category: pref.category,
                      inApp: checked,
                      email: pref.email,
                    })
                  }
                />
                <Switch
                  label={`Email (${meta.label})`}
                  checked={pref.email}
                  disabled={updatePrefMutation.isPending}
                  onCheckedChange={(checked) =>
                    updatePrefMutation.mutate({
                      category: pref.category,
                      inApp: pref.inApp,
                      email: checked,
                    })
                  }
                />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Notifications"
        description="Manage your alerts and delivery preferences."
        meta={unreadCount > 0 ? <Badge tone="brand">{unreadCount} unread</Badge> : undefined}
        actions={
          unreadCount > 0 ? (
            <Button
              variant="secondary"
              leadingIcon={<CheckCheck aria-hidden="true" />}
              loading={markAllReadMutation.isPending}
              onClick={() => markAllReadMutation.mutate({})}
            >
              Mark all read
            </Button>
          ) : undefined
        }
      />

      <Tabs
        label="Notification sections"
        defaultValue="activity"
        items={[
          {
            value: "activity",
            label: "Activity",
            badge: unreadCount > 0 ? <Badge tone="brand">{unreadCount}</Badge> : undefined,
            content: activityContent,
          },
          {
            value: "preferences",
            label: "Preferences",
            content: preferencesContent,
          },
        ]}
      />
    </div>
  );
}
