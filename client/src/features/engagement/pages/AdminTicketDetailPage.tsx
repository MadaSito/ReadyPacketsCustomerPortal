import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EyeOff, Send, UserCheck, UserMinus } from "lucide-react";
import { Link, useParams } from "wouter";
import type { TicketReplyView } from "@server/modules/engagement/ticketsService";
import type { TicketPriority, TicketStatus } from "@server/modules/engagement/types";
import { useSession } from "@/lib/session";
import { errorMessage, safeError, useTRPC, useTRPCClient } from "@/lib/trpc";
import {
  Badge,
  Breadcrumbs,
  Button,
  Callout,
  Card,
  CopyButton,
  DateTime,
  ErrorState,
  Field,
  Input,
  KeyValueList,
  LoadMore,
  PageHeader,
  RadioGroup,
  Select,
  Skeleton,
  Textarea,
  useToast,
} from "@/ui";
import {
  makeIdempotencyKey,
  TICKET_CATEGORY_LABELS,
  TICKET_PRIORITY_OPTIONS,
  TICKET_STATUS_META,
  TicketPriorityBadge,
  TicketStatusBadge,
} from "../helpers";

export default function AdminTicketDetailPage() {
  const { ticketId = "" } = useParams<{ ticketId: string }>();
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { me } = useSession();

  const [replyBody, setReplyBody] = useState("");
  const [replyMode, setReplyMode] = useState<"public" | "internal">("public");
  const [nextStatusOnReply, setNextStatusOnReply] = useState<TicketStatus | "">("");
  const [replyError, setReplyError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [assigneeDraft, setAssigneeDraft] = useState<string | null>(null);

  const [pagedState, setPagedState] = useState<{
    stamp: number;
    extraReplies: TicketReplyView[];
    nextCursor: string | null;
    error: unknown;
  }>({ stamp: 0, extraReplies: [], nextCursor: null, error: null });
  const [loadingMore, setLoadingMore] = useState(false);

  const [idemKey, setIdemKey] = useState(() => makeIdempotencyKey("staff_tkt"));

  const detailQuery = useQuery(
    trpc.engagement.tickets.admin.get.queryOptions({ ticketId, replyLimit: 50 }),
  );

  const stamp = detailQuery.dataUpdatedAt;
  const extraReplies = pagedState.stamp === stamp ? pagedState.extraReplies : [];
  const nextCursor =
    pagedState.stamp === stamp
      ? pagedState.nextCursor
      : (detailQuery.data?.repliesNextCursor ?? null);
  const paginationError = pagedState.stamp === stamp ? pagedState.error : null;
  const assigneeInput = assigneeDraft ?? (detailQuery.data?.ticket.assigneeUserPublicId ?? "");

  const invalidateAll = () => {
    setAssigneeDraft(null);
    void queryClient.invalidateQueries({ queryKey: trpc.engagement.tickets.pathKey() });
  };

  const loadMoreReplies = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await trpcClient.engagement.tickets.admin.get.query({
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
    trpc.engagement.tickets.admin.reply.mutationOptions({
      onSuccess: () => {
        setReplyBody("");
        setNextStatusOnReply("");
        setReplyError(undefined);
        setFormError(null);
        setIdemKey(makeIdempotencyKey("staff_tkt"));
        invalidateAll();
        toast.show({
          tone: "success",
          title: replyMode === "internal" ? "Internal note saved" : "Customer reply sent",
        });
      },
      onError: (err) => {
        setReplyError(safeError(err)?.fieldErrors?.body?.[0]);
        setFormError(errorMessage(err));
      },
    }),
  );

  const statusMutation = useMutation(
    trpc.engagement.tickets.admin.setStatus.mutationOptions({
      onSuccess: () => {
        invalidateAll();
        toast.show({ tone: "success", title: "Ticket status updated" });
      },
      onError: (err) =>
        toast.show({
          tone: "danger",
          title: "Could not change status",
          description: errorMessage(err),
        }),
    }),
  );

  const priorityMutation = useMutation(
    trpc.engagement.tickets.admin.setPriority.mutationOptions({
      onSuccess: () => {
        invalidateAll();
        toast.show({ tone: "success", title: "Ticket priority updated" });
      },
      onError: (err) =>
        toast.show({
          tone: "danger",
          title: "Could not change priority",
          description: errorMessage(err),
        }),
    }),
  );

  const assignMutation = useMutation(
    trpc.engagement.tickets.admin.assign.mutationOptions({
      onSuccess: () => {
        invalidateAll();
        toast.show({ tone: "success", title: "Ticket assignment updated" });
      },
      onError: (err) =>
        toast.show({
          tone: "danger",
          title: "Could not assign ticket",
          description: errorMessage(err),
        }),
    }),
  );

  const onReplySubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const norm = replyBody.normalize("NFC").trim();
    if (!norm) {
      setReplyError("Enter message text before submitting.");
      setFormError("Please enter a message.");
      return;
    }
    setReplyError(undefined);
    setFormError(null);
    replyMutation.mutate({
      ticketId,
      body: norm,
      internalOnly: replyMode === "internal",
      nextStatus: nextStatusOnReply || undefined,
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
  } = detailQuery.data;
  const allReplies = [...firstPageReplies, ...extraReplies];

  const statusOptions = [
    { value: "open", label: "Open" },
    { value: "pending_staff", label: "Needs staff reply" },
    { value: "pending_customer", label: "Awaiting customer" },
    { value: "resolved", label: "Resolved" },
    { value: "closed", label: "Closed" },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        breadcrumbs={
          <Breadcrumbs
            items={[
              { label: "Support queue", href: "/admin/tickets" },
              { label: ticket.ticketNumber },
            ]}
          />
        }
        title={ticket.subject}
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <TicketStatusBadge status={ticket.status} staffView />
            <TicketPriorityBadge priority={ticket.priority} />
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
          <Card title="Thread & internal notes">
            <ol className="flex flex-col gap-3" aria-label="Ticket thread">
              {allReplies.map((reply) => (
                <li
                  key={reply.publicId}
                  className={
                    reply.internalOnly
                      ? "rounded-[var(--radius-card)] border border-line bg-warning-soft p-4"
                      : "rounded-[var(--radius-card)] border border-line bg-surface p-4"
                  }
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-ink">{reply.authorDisplayLabel}</span>
                      <Badge tone={reply.authorRole === "customer" ? "neutral" : "info"}>
                        {reply.authorRole}
                      </Badge>
                      {reply.internalOnly ? (
                        <Badge tone="warning" icon={<EyeOff aria-hidden="true" />}>
                          Internal note
                        </Badge>
                      ) : null}
                    </div>
                    <span className="text-xs text-muted">
                      <DateTime value={reply.createdAt} format="datetime" />
                    </span>
                  </div>
                  {/* Plain text only */}
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
              summary={`Showing ${allReplies.length} entr${allReplies.length === 1 ? "y" : "ies"}`}
            />
          </Card>

          {canReply ? (
            <Card title={replyMode === "internal" ? "Add internal note" : "Reply to customer"}>
              <form onSubmit={onReplySubmit} noValidate className="flex flex-col gap-4">
                {formError ? (
                  <Callout tone="danger" live="assertive" title="Could not save reply">
                    {formError}
                  </Callout>
                ) : null}

                <RadioGroup
                  legend="Response mode"
                  variant="cards"
                  value={replyMode}
                  onValueChange={(val) => setReplyMode(val as "public" | "internal")}
                  options={[
                    {
                      value: "public",
                      label: "Customer-visible reply",
                      description: "Shown to the customer and notifies them by email if enabled.",
                    },
                    {
                      value: "internal",
                      label: "Internal staff note",
                      description: "Hidden from customers; leaves customer-visible timestamps unchanged.",
                    },
                  ]}
                />

                <Field
                  label={replyMode === "internal" ? "Internal note" : "Reply body"}
                  required
                  error={replyError}
                  labelAside={<span className="text-xs text-muted">{replyBody.length} / 8000</span>}
                >
                  <Textarea
                    rows={5}
                    maxLength={8000}
                    value={replyBody}
                    onChange={(event) => setReplyBody(event.target.value)}
                    placeholder={
                      replyMode === "internal"
                        ? "Document internal triage notes…"
                        : "Write a clear plain-text response to the customer…"
                    }
                  />
                </Field>

                <Field
                  label="Status after sending (optional)"
                  hint={
                    replyMode === "public"
                      ? "Defaults to Awaiting customer when left blank."
                      : "Defaults to keeping the current status unchanged."
                  }
                >
                  <Select
                    value={nextStatusOnReply}
                    onChange={(event) => setNextStatusOnReply(event.target.value as TicketStatus | "")}
                    options={[{ value: "", label: "Automatic default" }, ...statusOptions]}
                  />
                </Field>

                <div className="flex justify-end">
                  <Button
                    type="submit"
                    leadingIcon={<Send aria-hidden="true" />}
                    loading={replyMutation.isPending}
                  >
                    {replyMode === "internal" ? "Save internal note" : "Send reply"}
                  </Button>
                </div>
              </form>
            </Card>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <Card title="Triage controls">
            <div className="flex flex-col gap-4">
              <Field label="Status">
                <Select
                  value={ticket.status}
                  disabled={!canReply || statusMutation.isPending}
                  onChange={(event) =>
                    statusMutation.mutate({
                      ticketId,
                      toStatus: event.target.value as TicketStatus,
                    })
                  }
                  options={statusOptions}
                />
              </Field>

              <Field label="Priority">
                <Select
                  value={ticket.priority}
                  disabled={!canReply || priorityMutation.isPending}
                  onChange={(event) =>
                    priorityMutation.mutate({
                      ticketId,
                      priority: event.target.value as TicketPriority,
                    })
                  }
                  options={TICKET_PRIORITY_OPTIONS}
                />
              </Field>

              <div className="flex flex-col gap-2 border-t border-line pt-4">
                <Field
                  label="Assignee staff ID"
                  hint="Assign to yourself, paste a staff ULID, or clear assignment."
                >
                  <Input
                    value={assigneeInput}
                    onChange={(event) => setAssigneeDraft(event.target.value)}
                    maxLength={26}
                    spellCheck={false}
                    placeholder="Unassigned"
                  />
                </Field>
                <div className="flex flex-wrap gap-2">
                  {me?.user.publicId ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      leadingIcon={<UserCheck aria-hidden="true" />}
                      loading={assignMutation.isPending}
                      onClick={() =>
                        assignMutation.mutate({
                          ticketId,
                          assigneeUserId: me.user.publicId,
                        })
                      }
                    >
                      Assign to me
                    </Button>
                  ) : null}
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={assignMutation.isPending}
                    disabled={!assigneeInput.trim()}
                    onClick={() =>
                      assignMutation.mutate({
                        ticketId,
                        assigneeUserId: assigneeInput.trim(),
                      })
                    }
                  >
                    Assign ID
                  </Button>
                  {ticket.assigneeUserPublicId ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      leadingIcon={<UserMinus aria-hidden="true" />}
                      loading={assignMutation.isPending}
                      onClick={() =>
                        assignMutation.mutate({
                          ticketId,
                          assigneeUserId: null,
                        })
                      }
                    >
                      Unassign
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          </Card>

          <Card title="Metadata">
            <KeyValueList
              columns={1}
              items={[
                {
                  label: "Ticket number",
                  value: (
                    <span className="inline-flex items-center gap-2">
                      <span className="font-mono text-sm">{ticket.ticketNumber}</span>
                      <CopyButton value={ticket.ticketNumber} label="Copy ticket number" iconOnly size="sm" />
                    </span>
                  ),
                },
                {
                  label: "Customer",
                  value: (
                    <Link
                      href={`/admin/customers/${ticket.requesterUserPublicId}`}
                      className="font-semibold text-action underline-offset-2 hover:underline"
                    >
                      {ticket.requesterUserPublicId}
                    </Link>
                  ),
                },
                { label: "Category", value: TICKET_CATEGORY_LABELS[ticket.category] },
                {
                  label: "Related order",
                  value:
                    ticket.relatedOrderPublicId && ticket.relatedOrderReference ? (
                      <Link
                        href={`/admin/orders/${ticket.relatedOrderPublicId}`}
                        className="font-semibold text-action underline-offset-2 hover:underline"
                      >
                        {ticket.relatedOrderReference}
                      </Link>
                    ) : (
                      "None"
                    ),
                },
                { label: "Created", value: <DateTime value={ticket.createdAt} format="datetime" /> },
                { label: "Updated", value: <DateTime value={ticket.updatedAt} format="datetime" /> },
              ]}
            />
          </Card>

          <Card title="Status history">
            <ol className="flex flex-col gap-2 text-sm" aria-label="Ticket status history">
              {statusHistory.map((item) => (
                <li key={item.publicId} className="border-b border-line pb-2 last:border-b-0 last:pb-0">
                  <p className="font-medium text-ink">
                    {item.fromStatus
                      ? `${TICKET_STATUS_META[item.fromStatus].label} → ${TICKET_STATUS_META[item.toStatus].label}`
                      : `Opened (${TICKET_STATUS_META[item.toStatus].label})`}
                  </p>
                  <p className="text-xs text-muted">
                    {item.actorRole} · <DateTime value={item.occurredAt} format="datetime" />
                    {item.reasonCode ? ` · ${item.reasonCode}` : ""}
                  </p>
                </li>
              ))}
            </ol>
            {statusHistoryHasMore ? (
              <p className="mt-2 text-xs text-muted">Showing most recent 100 transitions.</p>
            ) : null}
          </Card>
        </div>
      </div>
    </div>
  );
}
