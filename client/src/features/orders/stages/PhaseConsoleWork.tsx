import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState, type FormEvent } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@server/trpc/root";
import type { StageAdminTask } from "@shared/workflowStages";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { Badge, Button, Callout, Checkbox, ConfirmDialog, DateTime, Field, Skeleton, Textarea, useToast } from "@/ui";

type Scope = { orderId: string; stageKey: string };
type Question = inferRouterOutputs<AppRouter>["orders"]["questions"]["list"]["questions"][number];
type Task = inferRouterOutputs<AppRouter>["orders"]["adminTasks"]["list"]["tasks"][number];
const TASK_LABELS: Record<StageAdminTask, string> = {
  upload_team_document: "Upload a team document",
  assign_questions: "Assign questions",
  review_submission: "Review the submission",
  run_automation: "Run phase actions",
};

function History({ scope, questionId }: { scope: Scope; questionId: string }) {
  const trpc = useTRPC();
  const [pages, setPages] = useState<number[]>([]);
  const beforeVersion = pages.at(-1);
  const history = useQuery(trpc.orders.questions.history.queryOptions({ ...scope, questionId, ...(beforeVersion ? { beforeVersion } : {}) }));
  if (history.isPending && pages.length === 0) return <><p role="status" className="sr-only">Loading answer history</p><Skeleton lines={2} /></>;
  const next = history.data?.nextBeforeVersion;
  return (
    <div className="min-w-0 space-y-2">
      <p role="status" className="text-sm font-medium text-ink">Answer history, page {pages.length + 1}{history.isPending ? ", loading" : ""}</p>
      {history.isError ? <Callout live="assertive" tone="danger" title="Could not load answer history"
        actions={<Button variant="secondary" onClick={() => void history.refetch()}>Retry</Button>}>{errorMessage(history.error)}</Callout> : null}
      {history.data?.answers.length === 0 ? <p className="text-sm text-muted">No answers yet.</p> : null}
      <ol className="space-y-2">
        {history.data?.answers.map((answer) => (
          <li key={answer.version} className="min-w-0 rounded-[var(--radius-control)] bg-surface-sunken p-3">
            <p className="text-sm font-medium text-ink">Version {answer.version} · <DateTime value={answer.answeredAt} /></p>
            <p className="text-sm text-muted break-words">{answer.answeredByPublicId ? `Account ${answer.answeredByPublicId}` : "Account unavailable"}</p>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">{answer.body}</p>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" aria-disabled={!pages.length || history.isPending} onClick={() => {
          if (pages.length && !history.isPending) setPages(pages.slice(0, -1));
        }}>Newer answers</Button>
        <Button variant="secondary" aria-disabled={!next || history.isPending} onClick={() => {
          if (next && !history.isPending) setPages([...pages, next]);
        }}>Older answers</Button>
      </div>
    </div>
  );
}

function StaffQuestion({ question, scope, canManage, refresh }: {
  question: Question; scope: Scope; canManage: boolean; refresh: () => Promise<unknown>;
}) {
  const trpc = useTRPC();
  const toast = useToast();
  const heading = useRef<HTMLHeadingElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [error, setError] = useState("");
  const historyId = useId();
  const withdraw = useMutation(trpc.orders.questions.withdraw.mutationOptions());
  return (
    <li className="min-w-0 space-y-2 rounded-[var(--radius-control)] border border-line px-4 py-3">
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        <h4 ref={heading} tabIndex={-1} className="min-w-0 flex-1 whitespace-pre-wrap break-words font-medium text-ink">{question.prompt}</h4>
        <Badge tone="neutral">{question.withdrawnAt ? "Withdrawn" : question.required ? "Required" : "Optional"}</Badge>
      </div>
      <p className="text-sm text-muted">Asked <DateTime value={question.askedAt} />{question.withdrawnAt ? <> · Withdrawn <DateTime value={question.withdrawnAt} /></> : null}</p>
      {question.latestAnswer ? (
        <div className="min-w-0 rounded-[var(--radius-control)] bg-surface-sunken p-3">
          <p className="text-sm font-medium text-ink">Latest answer, version {question.latestAnswer.version} · <DateTime value={question.latestAnswer.answeredAt} /></p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm">{question.latestAnswer.body}</p>
        </div>
      ) : <p className="text-sm text-muted">No answer yet.</p>}
      <div className="flex flex-wrap gap-2">
        {question.latestAnswer ? <Button variant="secondary" aria-expanded={historyOpen} aria-controls={historyId}
          onClick={() => setHistoryOpen(!historyOpen)}>{historyOpen ? "Hide answer history" : "Show answer history"}</Button> : null}
        {canManage && !question.withdrawnAt ? <Button variant="ghost" onClick={() => { setError(""); setWithdrawOpen(true); }}>Withdraw question</Button> : null}
      </div>
      <div id={historyId} hidden={!historyOpen}>
        {historyOpen ? <History questionId={question.questionId} scope={scope} /> : null}
      </div>
      <ConfirmDialog open={withdrawOpen} onOpenChange={setWithdrawOpen} title="Withdraw this question?"
        description="The customer will no longer see the question or be able to answer. Existing answer versions will stay in the console."
        destructive confirmLabel="Withdraw question" onConfirm={async () => {
          setError("");
          try {
            await withdraw.mutateAsync({ ...scope, questionId: question.questionId });
            await refresh();
            toast.show({ tone: "success", title: "Question withdrawn" });
            requestAnimationFrame(() => heading.current?.focus());
          } catch (cause) {
            setError(errorMessage(cause));
            throw cause;
          }
        }}>
        {error ? <Callout live="assertive" tone="danger">{error}</Callout> : null}
      </ConfirmDialog>
    </li>
  );
}

export function StaffPhaseQuestions({ orderId, stageKey }: Scope) {
  const trpc = useTRPC();
  const cache = useQueryClient();
  const toast = useToast();
  const scope = { orderId, stageKey };
  const headingId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const writing = useRef(false);
  const [prompt, setPrompt] = useState("");
  const [required, setRequired] = useState(false);
  const [error, setError] = useState("");
  const query = useQuery(trpc.orders.questions.list.queryOptions(scope));
  const ask = useMutation(trpc.orders.questions.ask.mutationOptions());
  const refresh = () => Promise.all([
    cache.invalidateQueries({ queryKey: trpc.orders.questions.list.queryKey(scope) }),
    cache.invalidateQueries({ queryKey: trpc.orders.questions.customerList.queryKey(scope) }),
    cache.invalidateQueries({ queryKey: trpc.orders.stages.workspace.queryKey({ orderId }) }),
  ]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (writing.current) return;
    const text = prompt.trim();
    if (!text) {
      setError("Enter a question.");
      inputRef.current?.focus();
      return;
    }
    setError("");
    writing.current = true;
    try {
      await ask.mutateAsync({ ...scope, prompt: text, required });
      setPrompt("");
      setRequired(false);
      await refresh();
      toast.show({ tone: "success", title: "Question assigned" });
      inputRef.current?.focus();
    } catch (cause) {
      setError(errorMessage(cause));
      inputRef.current?.focus();
    } finally {
      writing.current = false;
    }
  }

  return (
    <section aria-labelledby={headingId} data-clarity-mask="true" className="ph-no-capture min-w-0 space-y-3">
      <h3 id={headingId} className="font-semibold text-ink">Phase questions</h3>
      {query.isPending ? <><p role="status" className="sr-only">Loading phase questions</p><Skeleton lines={2} /></> : query.isError ? (
        <Callout live="assertive" tone="danger" title="Could not load phase questions"
          actions={<Button variant="secondary" onClick={() => void query.refetch()}>Retry</Button>}>{errorMessage(query.error)}</Callout>
      ) : (
        <>
          {query.data.canManage ? (
            <form onSubmit={(event) => void submit(event)} noValidate className="space-y-3 rounded-[var(--radius-control)] border border-line p-4">
              <Field label="Question for the customer" required error={error} hint="Up to 2,000 characters. Do not ask for passwords or verification codes.">
                <Textarea ref={inputRef} rows={3} maxLength={2_000} value={prompt} readOnly={ask.isPending}
                  onChange={(event) => { setPrompt(event.target.value); setError(""); }} />
              </Field>
              <p role="alert" className="sr-only">{error}</p>
              <Checkbox label="Require an answer before the customer continues" checked={required} onCheckedChange={setRequired} />
              <Button type="submit" loading={ask.isPending}>Assign question</Button>
            </form>
          ) : <p className="text-sm text-muted">Question assignment is unavailable for this phase. Existing answers remain readable.</p>}
          {query.data.questions.length === 0 ? <p className="text-sm text-muted">No questions have been assigned.</p> : (
            <ul className="space-y-3">
              {query.data.questions.map((question) => <StaffQuestion key={question.questionId} scope={scope}
                question={question} canManage={query.data.canManage} refresh={refresh} />)}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function ChecklistItem({ scope, task, canManage }: { scope: Scope; task: Task; canManage: boolean }) {
  const trpc = useTRPC();
  const cache = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const running = useRef(false);
  const change = useMutation(trpc.orders.adminTasks.set.mutationOptions());
  async function setChecked(checked: boolean) {
    if (!canManage || running.current) return;
    running.current = true;
    setSaving(true);
    setNotice("");
    setFailure("");
    try {
      await change.mutateAsync({ ...scope, taskKey: task.taskKey, checked, expectedVersion: task.version });
      setNotice(checked ? "Marked complete." : "Marked incomplete.");
    } catch (cause) {
      setFailure(errorMessage(cause));
    } finally {
      await cache.invalidateQueries({ queryKey: trpc.orders.adminTasks.list.queryKey(scope) });
      running.current = false;
      setSaving(false);
    }
  }
  return (
    <li className="min-w-0 border-t border-line py-3 last:pb-0" aria-busy={saving}>
      <Checkbox label={TASK_LABELS[task.taskKey]} checked={Boolean(task.checkedAt)} disabled={!canManage}
        onCheckedChange={(checked) => void setChecked(checked)} error={failure || undefined}
        description={task.checkedAt ? <><DateTime value={task.checkedAt} />{task.checkedByPublicId
          ? <span className="break-all"> · Account {task.checkedByPublicId}</span> : null}</> : "Not checked"} />
      <p className="sr-only" role="status">{notice}</p>
      <p className="sr-only" role="alert">{failure}</p>
    </li>
  );
}

export function AdminPhaseChecklist({ orderId, stageKey }: Scope) {
  const trpc = useTRPC();
  const id = useId();
  const scope = { orderId, stageKey };
  const query = useQuery(trpc.orders.adminTasks.list.queryOptions(scope));
  return (
    <section aria-labelledby={id} className="min-w-0 space-y-2">
      <h3 id={id} className="font-semibold text-ink">Administrator checklist</h3>
      <p className="text-sm text-muted">Track team work here. Checking an item does not run the action or review the submission.</p>
      {query.isPending ? <><p className="sr-only" role="status">Loading checklist</p><Skeleton lines={2} /></> : query.isError ? (
        <Callout tone="danger" title="Could not load checklist" live="assertive"
          actions={<Button variant="secondary" onClick={() => void query.refetch()}>Retry</Button>}>{errorMessage(query.error)}</Callout>
      ) : query.data.tasks.length ? (
        <ul className="space-y-1">
          {query.data.tasks.map((task) => <ChecklistItem key={task.taskKey} task={task} scope={scope} canManage={query.data.canManage} />)}
        </ul>
      ) : <p className="text-sm text-muted">No checklist items are configured for this phase.</p>}
    </section>
  );
}
