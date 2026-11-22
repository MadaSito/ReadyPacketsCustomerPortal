import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CheckCheck, Search } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useSession } from "@/lib/session";
import { errorMessage, useTRPC } from "@/lib/trpc";
import type { SearchDomain } from "@server/modules/engagement/types";
import {
  Badge,
  Button,
  DateTime,
  Drawer,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  Skeleton,
  useToast,
} from "@/ui";
import { safeInternalPath } from "./helpers";

export interface NotificationBellPopoverProps {
  area: "customer" | "console";
}

export interface GlobalSearchBoxProps {
  area?: "customer" | "console";
  className?: string;
}

export function useNotificationBellData(options: { includeList?: boolean } = {}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();

  const unreadQuery = useQuery(trpc.engagement.notifications.unreadCount.queryOptions({}));
  const listQuery = useQuery({
    ...trpc.engagement.notifications.list.queryOptions({ limit: 10 }),
    enabled: options.includeList ?? true,
  });

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.engagement.notifications.pathKey() });
  };

  const markReadMutation = useMutation(
    trpc.engagement.notifications.markRead.mutationOptions({
      onSuccess: invalidateAll,
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
      onSuccess: invalidateAll,
      onError: (err) =>
        toast.show({
          tone: "danger",
          title: "Could not mark notifications read",
          description: errorMessage(err),
        }),
    }),
  );

  return {
    unreadCount: unreadQuery.data?.unreadCount ?? 0,
    items: listQuery.data?.items ?? [],
    isLoading: listQuery.isPending,
    isSuccess: listQuery.isSuccess,
    isError: listQuery.isError,
    error: listQuery.error,
    refetch: () => {
      void unreadQuery.refetch();
      void listQuery.refetch();
    },
    markRead: (notificationId: string) => markReadMutation.mutate({ notificationId }),
    markAllRead: () => markAllReadMutation.mutate({}),
    markingAll: markAllReadMutation.isPending,
  };
}

/**
 * Shell header notification bell (44 px touch target) + accessible side Drawer.
 */
export function NotificationBellPopover({ area: _area }: NotificationBellPopoverProps) {
  const [open, setOpen] = useState(false);
  const {
    unreadCount,
    items,
    isSuccess,
    isError,
    error,
    refetch,
    markRead,
    markAllRead,
    markingAll,
  } = useNotificationBellData({ includeList: open });

  const badgeLabel = unreadCount > 99 ? "99+" : String(unreadCount);
  const buttonLabel =
    unreadCount > 0 ? `Notifications, ${badgeLabel} unread` : "Notifications";

  return (
    <Drawer
      open={open}
      onOpenChange={setOpen}
      side="right"
      width="md"
      title="Notifications"
      description="Recent alerts across your orders, tickets, and account."
      trigger={
        <Button
          variant="ghost"
          aria-label={buttonLabel}
          title={buttonLabel}
          className="relative size-11 p-0"
        >
          <Bell className="size-5" aria-hidden="true" />
          {unreadCount > 0 ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute -top-0.5 -right-0.5 inline-flex min-w-5 items-center justify-center rounded-full bg-action px-1.5 py-0.5 text-xs leading-none font-semibold text-on-action"
            >
              {badgeLabel}
            </span>
          ) : null}
        </Button>
      }
      footer={
        <Button asChild variant="secondary" block onClick={() => setOpen(false)}>
          <Link href="/notifications">View all notifications & preferences</Link>
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Badge tone={unreadCount > 0 ? "brand" : "neutral"}>
            {unreadCount > 0 ? `${unreadCount} unread` : "All caught up"}
          </Badge>
          {unreadCount > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<CheckCheck aria-hidden="true" />}
              loading={markingAll}
              onClick={markAllRead}
            >
              Mark all read
            </Button>
          ) : null}
        </div>

        {isError ? (
          <ErrorState error={error} onRetry={refetch} />
        ) : !isSuccess ? (
          <Skeleton lines={4} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={Bell}
            title="No notifications yet"
            description="Alerts for order updates, messages, and support replies will appear here."
          />
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Recent notifications">
            {items.map((item) => {
              const safeHref = safeInternalPath(item.link);
              const isUnread = item.readAt === null;
              return (
                <li
                  key={item.publicId}
                  className="rounded-[var(--radius-card)] border border-line bg-surface-soft p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 font-semibold break-words text-ink">{item.title}</p>
                    {isUnread ? <Badge tone="brand">Unread</Badge> : null}
                  </div>
                  <p className="mt-1 text-sm break-words whitespace-pre-wrap text-body">
                    {item.body}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                    <DateTime value={item.createdAt} format="relative" />
                    <div className="flex items-center gap-2">
                      {safeHref ? (
                        <Button
                          asChild
                          variant="link"
                          size="sm"
                          onClick={() => {
                            if (isUnread) markRead(item.publicId);
                            setOpen(false);
                          }}
                        >
                          <Link href={safeHref}>Open</Link>
                        </Button>
                      ) : null}
                      {isUnread ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => markRead(item.publicId)}
                        >
                          Mark read
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Drawer>
  );
}

/**
 * Debounced bounded search hook backed by `trpc.engagement.search.query`.
 */
export function useBoundedSearch(
  rawQuery: string,
  options: { domains?: SearchDomain[]; limitPerDomain?: number; debounceMs?: number } = {},
) {
  const trpc = useTRPC();
  const normalized = rawQuery.normalize("NFC").trim();
  const [debounced, setDebounced] = useState(normalized);

  useEffect(() => {
    const delay = options.debounceMs ?? 250;
    const handle = setTimeout(() => setDebounced(normalized), delay);
    return () => clearTimeout(handle);
  }, [normalized, options.debounceMs]);

  const enabled = debounced.length >= 2 && debounced.length <= 64;
  return useQuery({
    ...trpc.engagement.search.query.queryOptions({
      query: enabled ? debounced : "aa",
      domains: options.domains,
      limitPerDomain: options.limitPerDomain ?? 5,
    }),
    enabled,
  });
}

/**
 * Console/shell bounded global search input.
 * Routes staff/admin (or console area) to `/admin/search?q=...` and customers to `/search?q=...`.
 */
export function GlobalSearchBox({ area, className }: GlobalSearchBoxProps) {
  const [location, navigate] = useLocation();
  const { me } = useSession();
  const [query, setQuery] = useState("");

  const isConsole =
    area !== undefined
      ? area === "console"
      : location === "/admin" ||
        location.startsWith("/admin/") ||
        me?.user.role === "staff" ||
        me?.user.role === "admin";
  const searchBasePath = isConsole ? "/admin/search" : "/search";

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = query.normalize("NFC").trim();
    if (trimmed.length >= 2) {
      navigate(`${searchBasePath}?q=${encodeURIComponent(trimmed)}`);
    }
  };

  return (
    <form
      role="search"
      aria-label="Global search"
      onSubmit={onSubmit}
      className={className ?? "flex items-center gap-2"}
    >
      <Field label="Global search" hideLabel>
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search orders, tickets, messages…"
          maxLength={64}
        />
      </Field>
      <IconButton
        type="submit"
        label="Run search"
        icon={<Search className="size-4" aria-hidden="true" />}
        variant="ghost"
      />
    </form>
  );
}
