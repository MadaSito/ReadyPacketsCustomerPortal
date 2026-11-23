import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useSession } from "@/lib/session";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { roleHasCapability } from "@shared/capabilities";
import { Button, Callout, Card, ConfirmDialog, Countdown, DateTime, Dialog, ErrorState, Field, Input, Skeleton, StepUpCancelledError, useStepUp } from "@/ui";
import { fromLocalInput, toLocalInput } from "../admin/model";

const STATE_LABEL = { scheduled: "Scheduled", dispatching: "Queueing email", completed: "Queued for delivery", cancelled: "Cancelled" };

export function PolicyNoticeCard({ documentPublicId }: { documentPublicId: string }) {
  const api = useTRPC().compliance.policies.notices;
  const state = useQuery(api.status.queryOptions({ documentPublicId }, { refetchInterval: (query) => {
    const notice = query.state.data?.notice;
    return notice && (notice.state === "scheduled" || notice.state === "dispatching" || notice.queued > 0)
      ? 30_000 : false;
  } }));
  const delayMutation = useMutation(api.setDelay.mutationOptions());
  const reschedule = useMutation(api.reschedule.mutationOptions());
  const cancel = useMutation(api.cancel.mutationOptions());
  const send = useMutation(api.sendNow.mutationOptions());
  const remind = useMutation(api.remind.mutationOptions());
  const { me } = useSession();
  const stepUp = useStepUp();
  const [delay, setDelay] = useState<string | null>(null);
  const [localTime, setLocalTime] = useState("");
  const [action, setAction] = useState<"send" | "remind" | "cancel" | "reschedule" | null>(null);
  const [confirmedCount, setConfirmedCount] = useState(0);
  const reviewedNotice = useRef<{ noticePublicId: string; revision: number } | null>(null);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState("");
  const [clock, setClock] = useState(Date.now);
  const delayRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const notice = state.data?.notice;
  const reminderAt = notice?.reminderAvailableAt?.getTime();
  useEffect(() => {
    if (reminderAt === undefined || reminderAt <= clock) return;
    const timer = window.setTimeout(() => setClock(Date.now()), Math.min(2_147_483_647, Math.max(0, reminderAt - Date.now())));
    return () => window.clearTimeout(timer);
  }, [clock, reminderAt]);
  const reminderBlocked = reminderAt !== undefined && reminderAt > clock;
  const canSend = me ? roleHasCapability(me.user.role, "policies.notices.send") : false;

  const saveDelay = async () => {
    const value = delay ?? String(state.data?.delayHours ?? 24);
    setError(undefined);
    if (!/^\d+$/u.test(value) || Number(value) > 8760) {
      setError("Enter a whole number from 0 to 8,760.");
      delayRef.current?.focus();
      return;
    }
    try {
      await delayMutation.mutateAsync({ documentPublicId, delayHours: Number(value) });
      await state.refetch();
      setDelay(null);
      setMessage("Notice delay saved for future publications.");
    } catch (cause) { setError(errorMessage(cause)); }
  };

  const open = (next: typeof action) => {
    setError(undefined);
    reviewedNotice.current = next && notice ? { noticePublicId: notice.publicId, revision: notice.revision } : null;
    if (next === "reschedule" && notice) setLocalTime(toLocalInput(notice.scheduledAt));
    setConfirmedCount(notice?.pending ?? 0);
    setAction(next);
  };

  const perform = async () => {
    const input = reviewedNotice.current;
    if (!input || !action) return;
    setError(undefined);
    try {
      if (action === "reschedule") {
        const scheduledAt = fromLocalInput(localTime);
        if (!scheduledAt || scheduledAt.getTime() <= Date.now()) throw new Error("Select a future date and time.");
        await reschedule.mutateAsync({ ...input, scheduledAt });
      } else if (action === "cancel") {
        await cancel.mutateAsync(input);
      } else {
        const mutation = action === "send" ? send : remind;
        await stepUp.run(() => mutation.mutateAsync({ ...input, confirmedCount }), { reason: "Sending a policy notice requires fresh verification." });
      }
      setMessage(action === "reschedule" ? "Notice time updated." : action === "cancel" ? "Notice cancelled." : "Notice queued for sending.");
      setAction(null);
      await state.refetch();
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) headingRef.current?.focus();
      });
    } catch (cause) {
      if (!(cause instanceof StepUpCancelledError)) setError(errorMessage(cause, "The notice could not be updated. Refresh and try again."));
      await state.refetch();
      throw cause;
    }
  };

  const review = action === "send" || action === "remind";
  return (
    <Card>
      <div className="space-y-4">
        <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold">Policy update notice</h2>
        <p role="status" className="sr-only">{message}</p>
        {state.isPending ? <Skeleton lines={3} /> : state.isError ? (
          <ErrorState error={state.error} onRetry={() => void state.refetch()} />
        ) : (
          <>
            <form className="flex flex-wrap items-end gap-3" noValidate onSubmit={(event) => { event.preventDefault(); void saveDelay(); }}>
              <Field label="Delay for future publications (hours)" hint="Use 0 to queue notices immediately on publication." error={action ? undefined : error} className="min-w-0">
                <Input ref={delayRef} value={delay ?? String(state.data?.delayHours ?? 24)} maxLength={4} inputMode="numeric" onChange={(event) => setDelay(event.target.value)} className="max-w-32" />
              </Field>
              <Button type="submit" variant="secondary" loading={delayMutation.isPending}>Save delay</Button>
            </form>
            {notice ? (
              <>
                <p><strong>{STATE_LABEL[notice.state]}</strong>{notice.state === "scheduled" ? <> for <DateTime value={notice.scheduledAt} /></> : null}</p>
                {notice.state === "scheduled" ? <Countdown to={notice.scheduledAt} label="Policy notice sends" elapsedText="Waiting for worker" onElapsed={() => void state.refetch()} /> : null}
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div><dt>Queued</dt><dd>{notice.queued}</dd></div>
                  <div><dt>Sent</dt><dd>{notice.sent}</dd></div>
                  <div><dt>Failed</dt><dd>{notice.failed}</dd></div>
                  <div><dt>Accepted</dt><dd>{notice.accepted}</dd></div>
                </dl>
                <p className="text-sm text-muted">Sent means the mail provider accepted the message. Accepted counts policy acceptances.</p>
                <div className="flex flex-wrap gap-2">
                  {notice.state === "scheduled" ? (
                    <>
                      {canSend ? <Button className="max-w-full whitespace-normal" disabled={notice.pending === 0} onClick={() => open("send")}>Send notice to everyone now</Button> : null}
                      <Button variant="secondary" onClick={() => open("reschedule")}>Change time</Button>
                      <Button variant="secondary" onClick={() => open("cancel")}>Cancel notice</Button>
                    </>
                  ) : null}
                  {canSend && notice.state === "completed" && notice.pending > 0 ? (
                    <Button variant="secondary" className="max-w-full whitespace-normal" disabled={reminderBlocked} onClick={() => open("remind")}>Remind those who have not accepted</Button>
                  ) : null}
                </div>
                {notice.reminderAvailableAt && reminderBlocked
                  ? <p className="text-sm text-muted">Another reminder is available after <DateTime value={notice.reminderAvailableAt} />.</p> : null}
              </>
            ) : <p className="text-sm text-muted">A notice is scheduled when an active policy that requires acceptance is published.</p>}
          </>
        )}
      </div>
      <ConfirmDialog open={action === "cancel" || review} onOpenChange={(next) => { if (!next) open(null); }}
        title={action === "cancel" ? "Cancel this policy notice?" : action === "remind" ? "Send a reminder?" : "Send this policy notice now?"}
        description={review ? `This will email ${confirmedCount} ${confirmedCount === 1 ? "person" : "people"} who have not accepted this version and notify them in the portal.` : "The scheduled email and portal notifications will not be sent."}
        confirmLabel={action === "cancel" ? "Cancel notice" : "Send now"} destructive={action === "cancel"}
        onConfirm={perform}>
        {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
      </ConfirmDialog>
      <Dialog open={action === "reschedule"} onOpenChange={(next) => { if (!next) open(null); }} title="Change notice time" description="Enter the new date and time in your local time zone.">
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void perform().catch(() => undefined); }}>
          <Field label="New notice time" required error={error}>
            <Input type="datetime-local" value={localTime} onChange={(event) => setLocalTime(event.target.value)} />
          </Field>
          {error ? <span className="sr-only" role="alert">{error}</span> : null}
          <Button type="submit" loading={reschedule.isPending}>Save time</Button>
        </form>
      </Dialog>
    </Card>
  );
}
