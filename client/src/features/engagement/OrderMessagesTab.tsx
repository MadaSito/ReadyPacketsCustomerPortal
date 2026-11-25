import { useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheck, EyeOff, MessageSquare, Paperclip, Send } from "lucide-react";
import { errorMessage, safeError, useTRPC } from "@/lib/trpc";
import {
  Badge,
  Button,
  Callout,
  Card,
  DateTime,
  EmptyState,
  ErrorState,
  Field,
  LoadMore,
  RadioGroup,
  Skeleton,
  Textarea,
  useToast,
} from "@/ui";
import { makeIdempotencyKey } from "./helpers";

export interface OrderMessagesSlotProps {
  orderId: string;
  area: "customer" | "console";
}

export function OrderMessagesUnreadBadge({ orderId }: OrderMessagesSlotProps) {
  const trpc = useTRPC();
  const summary = useQuery(trpc.engagement.messages.unreadSummary.queryOptions({ orderId }));
  const unread = summary.data?.totalUnread ?? 0;
  if (unread <= 0) return null;
  return <Badge tone="brand">{unread > 99 ? "99+" : unread} unread</Badge>;
}

export default function OrderMessagesTab({ orderId, area }: OrderMessagesSlotProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<"customer" | "internal">("customer");
  const [formError, setFormError] = useState<string | null>(null);
  const [bodyError, setBodyError] = useState<string | undefined>(undefined);
  const [idemKey, setIdemKey] = useState(() => makeIdempotencyKey("msg"));

  const listQuery = useInfiniteQuery(
    trpc.engagement.messages.listByOrder.infiniteQueryOptions(
      { orderId, limit: 30 },
      { getNextPageParam: (lastPage) => lastPage.nextCursor },
    ),
  );
  const unreadSummary = useQuery(trpc.engagement.messages.unreadSummary.queryOptions({ orderId }));

  const invalidateThread = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.engagement.messages.pathKey() });
  };

  const markReadMutation = useMutation(
    trpc.engagement.messages.markOrderRead.mutationOptions({
      onSuccess: () => {
        invalidateThread();
        toast.show({ tone: "success", title: "Messages marked as read" });
      },
      onError: (err) =>
        toast.show({
          tone: "danger",
          title: "Could not mark messages read",
          description: errorMessage(err),
        }),
    }),
  );

  const sendMutation = useMutation(
    trpc.engagement.messages.send.mutationOptions({
      onSuccess: () => {
        setBody("");
        setFormError(null);
        setBodyError(undefined);
        setIdemKey(makeIdempotencyKey("msg"));
        invalidateThread();
        toast.show({
          tone: "success",
          title: visibility === "internal" ? "Internal note saved" : "Message sent",
        });
      },
      onError: (err) => {
        const safe = safeError(err);
        setBodyError(safe?.fieldErrors?.body?.[0]);
        setFormError(errorMessage(err));
      },
    }),
  );

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = body.normalize("NFC").trim();
    if (normalized.length === 0) {
      setBodyError("Enter a message before sending.");
      setFormError("Please fix the highlighted field.");
      return;
    }
    setBodyError(undefined);
    setFormError(null);
    sendMutation.mutate({
      orderId,
      body: normalized,
      visibility: area === "console" ? visibility : "customer",
      idempotencyKey: idemKey,
    });
  };

  if (!listQuery.data && listQuery.isError) {
    return (
      <ErrorState
        error={listQuery.error}
        onRetry={() => {
          void listQuery.refetch();
          void unreadSummary.refetch();
        }}
      />
    );
  }

  if (!listQuery.data) {
    return (
      <Card title="Order messages">
        <Skeleton lines={4} />
      </Card>
    );
  }

  // Pages arrive newest-first from server; present chronologically top-to-bottom.
  const allMessagesDesc = listQuery.data.pages.flatMap((p) => p.items);
  const chronological = [...allMessagesDesc].reverse();
  const unreadCount = unreadSummary.data?.totalUnread ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <Card
        title="Conversation"
        description="Plain-text messages for this order. Content is encrypted at rest and never sent in email bodies."
        actions={
          unreadCount > 0 ? (
            <Button
              variant="secondary"
              size="sm"
              leadingIcon={<CheckCheck aria-hidden="true" />}
              loading={markReadMutation.isPending}
              onClick={() => markReadMutation.mutate({ orderId })}
            >
              Mark {unreadCount} read
            </Button>
          ) : undefined
        }
      >
        {listQuery.isError ? (
          <div className="mb-3">
            <ErrorState
              error={listQuery.error}
              onRetry={() => {
                void listQuery.fetchNextPage();
              }}
            />
          </div>
        ) : null}

        <LoadMore
          hasMore={!!listQuery.hasNextPage}
          loading={listQuery.isFetchingNextPage}
          onLoadMore={() => listQuery.fetchNextPage()}
          summary={
            chronological.length > 0
              ? `Showing ${chronological.length} message${chronological.length === 1 ? "" : "s"}`
              : undefined
          }
        />

        {chronological.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title="No messages yet"
            description="Send a message below to reach the team working on this order."
          />
        ) : (
          <ol className="mt-3 flex flex-col gap-3" aria-label="Order message history">
            {chronological.map((msg) => {
              const isInternal = msg.visibility === "internal";
              return (
                <li
                  key={msg.publicId}
                  className={
                    isInternal
                      ? "rounded-[var(--radius-card)] border border-line bg-warning-soft p-4"
                      : msg.isOwnMessage
                        ? "rounded-[var(--radius-card)] border border-line bg-surface-soft p-4"
                        : "rounded-[var(--radius-card)] border border-line bg-surface p-4"
                  }
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-ink">{msg.authorDisplayLabel}</span>
                      <Badge tone={msg.authorRole === "customer" ? "neutral" : "info"}>
                        {msg.authorRole === "customer" ? "Customer" : "ReadyPackets team"}
                      </Badge>
                      {isInternal ? (
                        <Badge tone="warning" icon={<EyeOff aria-hidden="true" />}>
                          Internal note
                        </Badge>
                      ) : null}
                      {msg.unread && !msg.isOwnMessage ? (
                        <Badge tone="brand">Unread</Badge>
                      ) : null}
                    </div>
                    <span className="text-xs text-muted">
                      <DateTime value={msg.createdAt} format="datetime" />
                    </span>
                  </div>

                  {/* Plain text only — never HTML */}
                  <p className="mt-2 break-words whitespace-pre-wrap text-body">{msg.body}</p>

                  {msg.attachments.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Attached files">
                      {msg.attachments.map((att) => (
                        <Badge
                          key={att.filePublicId}
                          tone="neutral"
                          icon={<Paperclip aria-hidden="true" />}
                        >
                          {att.displayName ?? `File ${att.filePublicId.slice(-8)}`}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </Card>

      <Card title={area === "console" && visibility === "internal" ? "Add internal note" : "Send a message"}>
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          {formError ? (
            <Callout tone="danger" live="assertive" title="Could not send message">
              {formError}
            </Callout>
          ) : null}

          {area === "console" ? (
            <RadioGroup
              legend="Message visibility"
              variant="cards"
              value={visibility}
              onValueChange={(val) => setVisibility(val as "customer" | "internal")}
              options={[
                {
                  value: "customer",
                  label: "Customer reply",
                  description: "Visible to the customer and order collaborators; sends an alert.",
                },
                {
                  value: "internal",
                  label: "Internal staff note",
                  description: "Visible only to staff and administrators; never shown to customers.",
                },
              ]}
            />
          ) : null}

          <Field
            label="Message"
            required
            error={bodyError}
            hint="Plain text only (up to 4,000 characters). Do not include payment card numbers or passwords."
            labelAside={<span className="text-xs text-muted">{body.length} / 4000</span>}
          >
            <Textarea
              rows={4}
              maxLength={4000}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder={
                area === "console" && visibility === "internal"
                  ? "Write an internal note for staff…"
                  : "Write a message about this order…"
              }
            />
          </Field>

          <div className="flex justify-end">
            <Button
              type="submit"
              leadingIcon={<Send aria-hidden="true" />}
              loading={sendMutation.isPending}
            >
              {area === "console" && visibility === "internal" ? "Save internal note" : "Send message"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
