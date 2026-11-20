/** Console intake submissions viewer (/admin/intake/submissions): answers, revision history and review. Owner: orders_engineer (compliance admin UI). */
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Inbox } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useSearch } from "wouter";
import { useTRPC } from "@/lib/trpc";
import { Badge, Breadcrumbs, Button, Callout, Card, DataTable, DateTime, Dialog, EmptyState, ErrorState, Field, Input, KeyValueList, LoadMore, PageHeader, RadioGroup, Skeleton, Textarea } from "@/ui";
import { IntakeStatusBadge } from "../shared";
import { useGuardedAction } from "./common";
import { REVISION_EVENT_LABELS, ULID, answerText, type IntakeRevision, type OrderIntakeItem } from "./model";

export default function IntakeSubmissionsPage() {
  const search = useSearch();
  const initial = new URLSearchParams(search).get("order") ?? "";
  const [input, setInput] = useState(initial);
  const [orderId, setOrderId] = useState(ULID.test(initial) ? initial : "");
  const [inputError, setInputError] = useState<string | null>(null);
  const trpc = useTRPC();
  const items = useQuery(trpc.compliance.intake.listForOrder.queryOptions({ orderPublicId: orderId }, { enabled: orderId !== "" }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = input.trim();
    if (!ULID.test(trimmed)) return setInputError("Enter the 26-character order ID shown on the order page.");
    setInputError(null);
    setOrderId(trimmed);
  };
  return (
    <>
      <PageHeader title="Intake submissions" description="Review the answers customers submitted for an order, see every revision, and accept or return them for changes." breadcrumbs={<Breadcrumbs items={[{ label: "Intake questionnaires", href: "/admin/intake" }, { label: "Submissions" }]} />} />
      <div className="flex flex-col gap-6">
        <form onSubmit={submit} noValidate className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field label="Order ID" error={inputError ?? undefined} className="sm:w-96">
            <Input value={input} onChange={(e) => setInput(e.target.value)} maxLength={26} autoComplete="off" spellCheck={false} />
          </Field>
          <Button type="submit">Show submissions</Button>
        </form>
        {orderId === "" ? (
          <EmptyState icon={Inbox} title="Choose an order" description="Open an order and use its ID here, or follow the intake link from the order page." />
        ) : items.isPending ? (
          <Skeleton lines={6} />
        ) : items.error ? (
          <ErrorState error={items.error} onRetry={() => void items.refetch()} />
        ) : items.data.items.length === 0 ? (
          <EmptyState icon={Inbox} title="No questionnaires for this order" description="No published questionnaire applied to this order when it was placed." />
        ) : (
          <>
            <p className="text-sm text-body">
              Order{" "}
              <Link href={`/admin/orders/${orderId}`} className="break-all text-action underline-offset-2 hover:underline">
                {items.data.orderReference}
              </Link>
              {items.data.lockState !== "none" ? <span className="text-muted"> (locked: reviews may be blocked)</span> : null}
            </p>
            {items.data.items.map((item) => (
              <SubmissionCard key={item.questionnairePublicId} orderPublicId={orderId} item={item} />
            ))}
          </>
        )}
      </div>
    </>
  );
}

function SubmissionCard({ orderPublicId, item }: { orderPublicId: string; item: OrderIntakeItem }) {
  const [showHistory, setShowHistory] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const submission = item.submission;
  const fields = item.boundVersion.fields;
  return (
    <Card
      title={item.title}
      description={`Questionnaire version v${item.boundVersion.versionNumber}`}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <IntakeStatusBadge status={submission?.status ?? "not_started"} />
          {submission && item.canReview && submission.status === "submitted" ? (
            <Button size="sm" onClick={() => setReviewing(true)}>
              Review{" "}<span className="sr-only">{item.title}</span>
            </Button>
          ) : null}
        </div>
      }
    >
      {submission ? (
        <div className="flex flex-col gap-4">
          <KeyValueList
            items={[
              { label: "Revision", value: submission.revisionNumber },
              { label: "Submitted", value: <DateTime value={submission.submittedAt} /> },
              { label: "Reviewed", value: <DateTime value={submission.reviewedAt} /> },
              ...(submission.latestReviewNote ? [{ label: "Latest review note", value: <span className="break-words whitespace-pre-line">{submission.latestReviewNote}</span>, wide: true }] : []),
            ]}
          />
          <Answers fields={fields} answers={submission.answers} />
          <div>
            <Button size="sm" variant="secondary" aria-expanded={showHistory} onClick={() => setShowHistory((v) => !v)}>
              {showHistory ? "Hide revision history" : "Show revision history"}
              {" "}<span className="sr-only">for {item.title}</span>
            </Button>
          </div>
          {showHistory ? <RevisionHistory orderPublicId={orderPublicId} item={item} /> : null}
        </div>
      ) : (
        <p className="text-body">The customer has not started this questionnaire.</p>
      )}
      {reviewing && submission ? <ReviewDialog submissionPublicId={submission.submissionPublicId} title={item.title} onClose={() => setReviewing(false)} /> : null}
    </Card>
  );
}

function Answers({ fields, answers }: { fields: OrderIntakeItem["boundVersion"]["fields"]; answers: Record<string, unknown> }) {
  return (
    <section aria-label="Answers">
      <KeyValueList
        columns={1}
        items={fields.map((f) => ({
          label: (
            <span className="flex flex-wrap items-center gap-2">
              {f.label}
              {f.sensitive ? <Badge tone="warning">Sensitive</Badge> : null}
            </span>
          ),
          value: <span className="break-words whitespace-pre-line">{answerText(answers[f.key], f.options)}</span>,
        }))}
      />
    </section>
  );
}

function RevisionHistory({ orderPublicId, item }: { orderPublicId: string; item: OrderIntakeItem }) {
  const trpc = useTRPC();
  const history = useInfiniteQuery(
    trpc.compliance.intake.getSubmission.infiniteQueryOptions({ orderPublicId, questionnairePublicId: item.questionnairePublicId, limit: 10 }, { getNextPageParam: (page) => page.nextCursor ?? undefined }),
  );
  const rows = history.data?.pages.flatMap((page) => page.revisions);
  const [open, setOpen] = useState<IntakeRevision | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <DataTable<IntakeRevision>
        caption={`Revision history for ${item.title}`}
        rows={rows}
        loading={history.isPending}
        error={history.error}
        onRetry={() => void history.refetch()}
        rowKey={(r) => r.revisionPublicId}
        columns={[
          { key: "revision", header: "Revision", primary: true, cell: (r) => `#${r.revisionNumber}` },
          { key: "event", header: "Event", cell: (r) => REVISION_EVENT_LABELS[r.eventKind] },
          { key: "actor", header: "By", cell: (r) => r.actorRole.charAt(0).toUpperCase() + r.actorRole.slice(1) },
          { key: "when", header: "When", cell: (r) => <DateTime value={r.occurredAt} /> },
          { key: "note", header: "Review note", hideOnMobile: true, cell: (r) => <span className="break-words">{r.reviewNote ?? "—"}</span> },
        ]}
        rowActions={(r) => (
          <Button size="sm" variant="ghost" onClick={() => setOpen(r)}>
            View answers{" "}<span className="sr-only">for revision {r.revisionNumber}</span>
          </Button>
        )}
        empty={<p className="text-body">No revisions recorded.</p>}
      />
      {rows ? <LoadMore hasMore={Boolean(history.hasNextPage)} loading={history.isFetchingNextPage} onLoadMore={() => void history.fetchNextPage()} label="Load older revisions" /> : null}
      {open ? (
        <Dialog open size="lg" onOpenChange={(value) => (value ? undefined : setOpen(null))} title={`Revision #${open.revisionNumber}`} description={REVISION_EVENT_LABELS[open.eventKind]}>
          <Answers fields={item.boundVersion.fields} answers={open.answers} />
        </Dialog>
      ) : null}
    </div>
  );
}

function ReviewDialog({ submissionPublicId, title, onClose }: { submissionPublicId: string; title: string; onClose: () => void }) {
  const trpc = useTRPC();
  const guarded = useGuardedAction();
  const review = useMutation(trpc.compliance.intake.review.mutationOptions());
  const [decision, setDecision] = useState<"accepted" | "returned_for_changes">("accepted");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (decision === "returned_for_changes" && !note.trim()) return setError("Tell the customer what needs to change.");
    setError(null);
    const result = await guarded(() => review.mutateAsync({ submissionPublicId, decision, reviewNote: note.trim() || undefined }), {
      reason: "Reviewing intake needs verification.",
      success: decision === "accepted" ? "Submission accepted" : "Returned to the customer for changes",
    });
    if (result.ok) onClose();
    else setError(result.error);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={`Review ${title}`}
      footer={
        <Button loading={review.isPending} onClick={() => void submit()}>
          Save review
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
        <RadioGroup
          legend="Decision"
          value={decision}
          onValueChange={(value) => setDecision(value as typeof decision)}
          options={[
            { value: "accepted", label: "Accept" },
            { value: "returned_for_changes", label: "Return for changes" },
          ]}
        />
        <Field label="Note to the customer" hint={decision === "returned_for_changes" ? "Required. Visible to the customer." : "Optional. Visible to the customer."}>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={4} />
        </Field>
      </div>
    </Dialog>
  );
}
