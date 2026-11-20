import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MailOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { errorMessage, useTRPC, useTRPCClient } from "@/lib/trpc";
import {
  Button, Callout, CodeBlock, ConfirmDialog, DataTable, DateTime, Dialog, EmptyState,
  Field, FilterBar, KeyValueList, LoadMore, PageHeader, Select, StepUpCancelledError, useStepUp,
} from "@/ui";
import { AuditLink, Id, mailLabels, mailStates, MailStatus } from "../controls";

type Capture = { to: string; subject: string; text: string };
const stateOptions = [{ value: "", label: "All delivery states" }, ...mailStates.map((state) => ({ value: state, label: mailLabels[state] }))];

export default function MailPage() {
  const trpc = useTRPC();
  const rpc = useTRPCClient();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const [status, setStatus] = useState<(typeof mailStates)[number] | "">("");
  const [selected, setSelected] = useState<{ publicId: string; correlationId: string; jobPublicId: string | null } | null>(null);
  const [pendingResend, setPendingResend] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const resend = useMutation(trpc.jobs.admin.resend.mutationOptions());
  const result = useInfiniteQuery(trpc.jobs.admin.listMail.infiniteQueryOptions(
    { state: status || undefined, limit: 25 }, { getNextPageParam: (page) => page.nextCursor ?? undefined },
  ));
  const attempts = useQuery(trpc.jobs.admin.mailDetail.queryOptions({ publicId: selected?.publicId ?? "" }, { enabled: !!selected }));
  const rows = result.data?.pages.flatMap((page) => page.items) ?? [];

  useEffect(() => {
    if (!capture) return;
    const timer = setTimeout(() => setCapture(null), 120_000);
    return () => clearTimeout(timer);
  }, [capture]);

  const viewCapture = async (publicId: string) => {
    setCaptureError(null);
    setCapturing(true);
    try {
      // Bypass the mutation cache: rendered sensitive content belongs only in this dialog's state.
      setCapture(await stepUp.run(() => rpc.jobs.admin.capture.mutate({ publicId }), { reason: "Opening captured mail requires fresh verification." }));
    } catch (failure) {
      if (!(failure instanceof StepUpCancelledError)) setCaptureError(errorMessage(failure));
    } finally {
      setCapturing(false);
    }
  };

  const confirmResend = async () => {
    if (!pendingResend) return;
    setResendError(null);
    setMessage(null);
    try {
      await resend.mutateAsync({ publicId: pendingResend });
      setMessage("The message is queued for another attempt. It has not been sent.");
      void qc.invalidateQueries(trpc.jobs.admin.pathFilter());
    } catch (failure) {
      setResendError(errorMessage(failure));
      throw failure;
    }
  };

  return <>
    <PageHeader title="Mail" description="Review the outgoing mail queue and delivery attempts." />
    <FilterBar activeCount={Number(Boolean(status))} onReset={() => setStatus("")}>
      <Field label="Delivery state"><Select options={stateOptions} value={status} onChange={(event) =>
        setStatus(mailStates.find((value) => value === event.target.value) ?? "")} /></Field>
    </FilterBar>
    <Callout title="Acceptance is not delivery" tone="info">
      SMTP acceptance means the server accepted the submission. It does not confirm arrival in the recipient’s inbox.
    </Callout>
    {message ? <Callout tone="success" live="polite">{message}</Callout> : null}
    {captureError ? <Callout tone="danger" live="assertive">{captureError}</Callout> : null}
    <DataTable caption="Outgoing mail" rows={rows} rowKey={(row) => row.publicId} loading={result.isPending}
      error={result.error} onRetry={() => void result.refetch()}
      empty={<EmptyState icon={MailOpen} title="No matching messages" description="Mail appears here after it is queued by portal activity." />}
      columns={[
        { key: "template", header: "Template", primary: true, cell: (row) => <Id value={row.template} /> },
        { key: "status", header: "Status", cell: (row) => <MailStatus state={row.state} /> },
        { key: "reason", header: "Reason", cell: (row) => <Id value={row.reasonCode} /> },
        { key: "updated", header: "Updated", cell: (row) => <DateTime value={row.updatedAt} format="relative" /> },
      ]}
      rowActions={(row) => <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => setSelected(row)} aria-label={`Attempts for message ${row.publicId}`}>Attempts</Button>
        {row.canResend ? <Button variant="secondary" aria-label={`Resend message ${row.publicId}`} onClick={() => setPendingResend(row.publicId)}>Resend</Button> : null}
        {row.canViewCapture ? <Button variant="secondary" aria-label={`View capture for message ${row.publicId}`}
          disabled={capturing} onClick={() => void viewCapture(row.publicId)}>View capture</Button> : null}
      </div>} />
    <LoadMore hasMore={result.hasNextPage} loading={result.isFetchingNextPage} onLoadMore={() => void result.fetchNextPage()}
      summary={!result.isPending && !result.isError ? `Showing ${rows.length} messages` : undefined} />
    <Dialog title="Mail attempts" description="This history does not expose recipients or message content." size="lg"
      open={!!selected} onOpenChange={(open) => { if (!open) setSelected(null); }}
      footer={selected ? <>
        <AuditLink correlationId={selected.correlationId} />
        {selected.jobPublicId ? <Button asChild variant="secondary"><Link href={`/admin/jobs/${selected.jobPublicId}`}>View related job</Link></Button> : null}
      </> : null}>
      <DataTable caption="Message attempt history" rowKey={(row) => String(row.generation)} rows={attempts.data?.attempts ?? []}
        loading={attempts.isPending} error={attempts.error} onRetry={() => void attempts.refetch()}
        empty={<EmptyState title="No delivery attempts yet" description="Attempts appear after a worker processes the message." />}
        columns={[
          { key: "attempt", header: "Attempt", primary: true, cell: (row) => <span className="tabular-nums">{row.generation}</span> },
          { key: "state", header: "Outcome", cell: (row) => <MailStatus state={row.state} /> },
          { key: "reason", header: "Reason", cell: (row) => <Id value={row.reasonCode} /> },
          { key: "finished", header: "Finished", cell: (row) => <DateTime value={row.finishedAt} /> },
        ]} />
    </Dialog>
    {pendingResend ? <ConfirmDialog open onOpenChange={(open) => { if (!open) { setPendingResend(null); setResendError(null); } }}
      title="Queue this message again?" description="The existing attempt history is preserved. A worker will make a new attempt if the message has not expired."
      confirmLabel="Queue resend" onConfirm={confirmResend}>
      {resendError ? <Callout tone="danger" live="assertive">{resendError}</Callout> : null}
    </ConfirmDialog> : null}
    {capture ? <Dialog title="Captured mail" description="Testing only. This message was not sent, and viewing it is audited."
      open onOpenChange={(open) => { if (!open) setCapture(null); }}>
      <KeyValueList items={[{ label: "Recipient", value: <span className="break-all">{capture.to}</span> },
        { label: "Subject", value: capture.subject }]} />
      <CodeBlock label="Plain-text message" wrap>{capture.text}</CodeBlock>
    </Dialog> : null}
  </>;
}
