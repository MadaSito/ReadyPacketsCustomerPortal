import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, RotateCcw, Send } from "lucide-react";
import { Link, useParams } from "wouter";
import type { TicketReplyView } from "@server/modules/engagement/ticketsService";
import { errorMessage, safeError, useTRPC, useTRPCClient } from "@/lib/trpc";
import {
  Badge,
  Breadcrumbs,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  CopyButton,
  DateTime,
  Dialog,
  DialogClose,
  ErrorState,
  Field,
  KeyValueList,
  LoadMore,
  PageHeader,
  Skeleton,
  Textarea,
  useToast,
} from "@/ui";
import {
  makeIdempotencyKey,
  TICKET_CATEGORY_LABELS,
  TICKET_STATUS_META,
  TicketPriorityBadge,
  TicketStatusBadge,
} from "../helpers";

export default function SupportTicketDetailPage() {
  const { ticketId = "" } = useParams<{ ticketId: string }>();
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [replyBody, setReplyBody] = useState("");
  const [replyError, setReplyError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [closeOpen, setCloseOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState("");
  const [reopenError, setReopenError] = useState<string | undefined>(undefined);

  const [pagedState, setPagedState] = useState<{
    stamp: number;
    extraReplies: TicketReplyView[];
    nextCursor: string | null;
    error: unknown;
  }>({ stamp: 0, extraReplies: [], nextCursor: null, error: null });
  const [loadingMore, setLoadingMore] = useState(false);

  const [idemKey, setIdemKey] = useState(() => makeIdempotencyKey("tkt_reply"));

  const detailQuery = useQuery(
    trpc.engagement.tickets.get.queryOptions({ ticketId, replyLimit: 50 }),
  );

  const stamp = detailQuery.dataUpdatedAt;
  const extraReplies = pagedState.stamp === stamp ? pagedState.extraReplies : [];
  const nextCursor =
    pagedState.stamp === stamp
      ? pagedState.nextCursor
      : (detailQuery.data?.repliesNextCursor ?? null);
  const paginationError = pagedState.stamp === stamp ? pagedState.error : null;

  const invalidateTicket = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.engagement.tickets.pathKey() });
  };

  const loadMoreReplies = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await trpcClient.engagement.tickets.get.query({
        ticketId,
        replyCursor: nextCursor,
        replyLimit: 50,
      });
      setPagedState({
        stamp,
        extraReplies: [...extraReplies, ...page.replies],
        nextCursor: page.repliesNextCursor,
        error: null,
      });
    } catch (err) {
      setPagedState({
        stamp,
        extraReplies,
        nextCursor,
        error: err,
      });
    } finally {
      setLoadingMore(false);
    }
  };

  const replyMutation = useMutation(
    trpc.engagement.tickets.reply.mutationOptions({
      onSuccess: () => {
        setReplyBody("");
        setReplyError(undefined);
        setFormError(null);
        setIdemKey(makeIdempotencyKey("tkt_reply"));
        invalidateTicket();
        toast.show({ tone: "success", title: "Reply posted" });
      },
      onError: (err) => {
        setReplyError(safeError(err)?.fieldErrors?.body?.[0]);
        setFormError(errorMessage(err));
      },
    }),
  );

  const closeMutation = useMutation(
    trpc.engagement.tickets.close.mutationOptions({
      onSuccess: () => {
        invalidateTicket();
        toast.show({ tone: "success", title: "Ticket closed" });
      },
    }),
  );

  const reopenMutation = useMutation(
    trpc.engagement.tickets.reopen.mutationOptions({
      onSuccess: () => {
        setReopenOpen(false);
        setReopenReason("");
        setReopenError(undefined);
        invalidateTicket();
        toast.show({ tone: "success", title: "Ticket reopened" });
      },
      onError: (err) => {
        setReopenError(safeError(err)?.fieldErrors?.reason?.[0] ?? errorMessage(err));
      },
    }),
  );

  const onReplySubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const norm = replyBody.normalize("NFC").trim();
    if (!norm) {
      setReplyError("Enter a reply before submitting.");
      setFormError("Please enter a reply.");
      return;
    }
    setReplyError(undefined);
    setFormError(null);
    replyMutation.mutate({
      ticketId,
      body: norm,
      idempotencyKey: idemKey,
    });
  };

  if (detailQuery.isError) {
    return (
      <ErrorState
        error={detailQuery.error}
        onRetry={() => {
          void detailQuery.refetch();
        }}
      />
    );
  }

  if (!detailQuery.isSuccess) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Loading ticket…" />
        <Skeleton lines={5} />
      </div>
    );
  }

  const {
    ticket,
    replies: firstPageReplies,
    statusHistory,
    statusHistoryHasMore,
    canReply,
    canReopen,
    canClose,
  } = detailQuery.data;
  const allReplies = [...firstPageReplies, ...extraReplies];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        breadcrumbs={
          <Breadcrumbs
            items={[
              { label: "Support tickets", href: "/support" },
              { label: ticket.ticketNumber },
            ]}
          />
        }
        title={ticket.subject}
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <TicketStatusBadge status={ticket.status} />
            <TicketPriorityBadge priority={ticket.priority} />
          </div>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canReopen ? (
              <Button
                variant="secondary"
                leadingIcon={<RotateCcw aria-hidden="true" />}
                onClick={() => setReopenOpen(true)}
              >
                Reopen ticket
              </Button>
            ) : null}
            {canClose ? (
              <Button
                variant="secondary"
                leadingIcon={<Lock aria-hidden="true" />}
                onClick={() => setCloseOpen(true)}
              >
                Close ticket
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
          <Card title="Conversation">
            <ol className="flex flex-col gap-3" aria-label="Ticket replies">
              {allReplies.map((reply) => (
                <li
                  key={reply.publicId}
                  className={
                    reply.isOwnMessage
                      ? "rounded-[var(--radius-card)] border border-line bg-surface-soft p-4"
                      : "rounded-[var(--radius-card)] border border-line bg-surface p-4"
                  }
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-ink">{reply.authorDisplayLabel}</span>
                      <Badge tone={reply.authorRole === "customer" ? "neutral" : "info"}>
                        {reply.authorRole === "customer" ? "Customer" : "Support team"}
                      </Badge>
                    </div>
                    <span className="text-xs text-muted">
                      <DateTime value={reply.createdAt} format="datetime" />
                    </span>
                  </div>
                  {/* Plain text only — never HTML */}
                  <p className="mt-2 break-words whitespace-pre-wrap text-body">{reply.body}</p>
                </li>
              ))}
            </ol>

            {paginationError ? (
              <div className="mt-3">
                <ErrorState
                  error={paginationError}
                  onRetry={() => {
                    void loadMoreReplies();
                  }}
                />
              </div>
            ) : null}

            <LoadMore
              hasMore={nextCursor !== null}
              loading={loadingMore}
              onLoadMore={loadMoreReplies}
              summary={`Showing ${allReplies.length} repl${allReplies.length === 1 ? "y" : "ies"}`}
            />
          </Card>

          {canReply ? (
            <Card title="Send a reply">
              <form onSubmit={onReplySubmit} noValidate className="flex flex-col gap-4">
                {formError ? (
                  <Callout tone="danger" live="assertive" title="Could not post reply">
                    {formError}
                  </Callout>
                ) : null}
                <Field
                  label="Your reply"
                  required
                  error={replyError}
                  hint="Plain text only (up to 8,000 characters)."
                  labelAside={<span className="text-xs text-muted">{replyBody.length} / 8000</span>}
                >
                  <Textarea
                    rows={4}
                    maxLength={8000}
                    value={replyBody}
                    onChange={(event) => setReplyBody(event.target.value)}
                    placeholder="Write a reply…"
                  />
                </Field>
                <div className="flex justify-end">
                  <Button
                    type="submit"
                    leadingIcon={<Send aria-hidden="true" />}
                    loading={replyMutation.isPending}
                  >
                    Post reply
                  </Button>
                </div>
              </form>
            </Card>
          ) : (
            <Callout tone="info" title="This ticket is closed to new replies">
              Need further help?{" "}
              <Link href="/support/new" className="font-semibold text-action underline">
                Open a new support ticket
              </Link>
              .
            </Callout>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <Card title="Ticket details">
            <KeyValueList
              columns={1}
              items={[
                {
                  label: "Reference",
                  value: (
                    <span className="inline-flex items-center gap-2">
                      <span className="font-mono text-sm">{ticket.ticketNumber}</span>
                      <CopyButton value={ticket.ticketNumber} label="Copy ticket reference" iconOnly size="sm" />
                    </span>
                  ),
                },
                { label: "Category", value: TICKET_CATEGORY_LABELS[ticket.category] },
                {
                  label: "Related order",
                  value:
                    ticket.relatedOrderPublicId && ticket.relatedOrderReference ? (
                      <Link
                        href={`/orders/${ticket.relatedOrderPublicId}`}
                        className="font-semibold text-action underline-offset-2 hover:underline"
                      >
                        {ticket.relatedOrderReference}
                      </Link>
                    ) : (
                      "None"
                    ),
                },
                { label: "Opened", value: <DateTime value={ticket.createdAt} format="datetime" /> },
                { label: "Last updated", value: <DateTime value={ticket.updatedAt} format="relative" /> },
              ]}
            />
          </Card>

          <Card title="Status history">
            <ol className="flex flex-col gap-2.5 text-sm" aria-label="Ticket status history">
              {statusHistory.map((item) => (
                <li key={item.publicId} className="border-b border-line pb-2 last:border-b-0 last:pb-0">
                  <p className="font-medium text-ink">
                    {item.fromStatus
                      ? `${TICKET_STATUS_META[item.fromStatus].label} → ${TICKET_STATUS_META[item.toStatus].label}`
                      : `Opened (${TICKET_STATUS_META[item.toStatus].label})`}
                  </p>
                  <p className="text-xs text-muted">
                    <DateTime value={item.occurredAt} format="datetime" />
                  </p>
                </li>
              ))}
            </ol>
            {statusHistoryHasMore ? (
              <p className="mt-2 text-xs text-muted">Showing most recent 100 status changes.</p>
            ) : null}
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={closeOpen}
        onOpenChange={setCloseOpen}
        title="Close this support ticket?"
        description="Closed tickets cannot be reopened. You can always open a new ticket if you need help later."
        confirmLabel="Close ticket"
        onConfirm={async () => {
          await closeMutation.mutateAsync({ ticketId });
        }}
      />

      <Dialog
        open={reopenOpen}
        onOpenChange={setReopenOpen}
        title="Reopen support ticket"
        description="Tell our support team what still needs attention."
        footer={
          <>
            <DialogClose>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <Button
              loading={reopenMutation.isPending}
              onClick={() => {
                const norm = reopenReason.normalize("NFC").trim();
                if (norm.length < 3) {
                  setReopenError("Enter at least 3 characters.");
                  return;
                }
                setReopenError(undefined);
                reopenMutation.mutate({ ticketId, reason: norm });
              }}
            >
              Reopen ticket
            </Button>
          </>
        }
      >
        <Field label="Reason for reopening" required error={reopenError}>
          <Textarea
            rows={4}
            maxLength={500}
            value={reopenReason}
            onChange={(event) => setReopenReason(event.target.value)}
            placeholder="Describe your follow-up question…"
          />
        </Field>
      </Dialog>
    </div>
  );
}
