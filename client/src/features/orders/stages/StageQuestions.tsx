import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@server/trpc/root";
import { AgreementDialog, parseAgreementRequiredDetails, type AgreementRequiredDetails } from "@/lib/agreementGate";
import { errorMessage, safeError, useTRPC } from "@/lib/trpc";
import { Badge, Button, Callout, DateTime, Field, Skeleton, Textarea } from "@/ui";

type Scope = { orderId: string; stageKey: string };
type Question = inferRouterOutputs<AppRouter>["orders"]["questions"]["customerList"]["questions"][number];
const MAX_ANSWER_LENGTH = 8_000;

function CustomerQuestion({ scope, question, canAnswer, Heading }: {
  scope: Scope; question: Question; canAnswer: boolean; Heading: "h4" | "h5";
}) {
  const id = useId();
  const trpc = useTRPC();
  const cache = useQueryClient();
  const editor = useRef<HTMLTextAreaElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const resumeFocus = useRef<"heading" | "trigger" | null>(null);
  const busy = useRef(false);
  const [edit, setEdit] = useState<{ body: string; baseVersion: number } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [status, setStatus] = useState("");
  const [agreement, setAgreement] = useState<AgreementRequiredDetails | null>(null);
  const write = useMutation(trpc.orders.questions.answer.mutationOptions());
  const editing = Boolean(edit) && canAnswer;
  useEffect(() => {
    if (editing) editor.current?.focus();
    else if (resumeFocus.current) {
      const target = resumeFocus.current === "trigger" ? (trigger.current ?? heading.current) : heading.current;
      resumeFocus.current = null;
      target?.focus();
    }
  }, [editing]);

  async function save(draft: { body: string; baseVersion: number }, canRequestAgreement: boolean) {
    if (busy.current) return;
    const body = draft.body.trim();
    setStatus("");
    setFailure(null);
    if (!body) {
      setFailure("Enter an answer before saving.");
      editor.current?.focus();
      return;
    }
    busy.current = true;
    try {
      const { version } = await write.mutateAsync({ ...scope, questionId: question.questionId, body, expectedVersion: draft.baseVersion });
      setStatus(`Answer saved as version ${version}.`);
      resumeFocus.current = "heading";
      setEdit(null);
      await Promise.all([
        cache.invalidateQueries({ queryKey: trpc.orders.questions.customerList.queryKey(scope) }),
        cache.invalidateQueries({ queryKey: trpc.orders.stages.workspace.queryKey({ orderId: scope.orderId }) }),
      ]);
    } catch (cause) {
      const gate = canRequestAgreement ? parseAgreementRequiredDetails(cause) : null;
      if (gate) setAgreement(gate);
      else {
        setFailure(errorMessage(cause));
        if (safeError(cause)?.reasonCode === "QUESTION_ANSWER_VERSION_CHANGED") {
          setStale(true);
          await cache.invalidateQueries({ queryKey: trpc.orders.questions.customerList.queryKey(scope) });
        }
        editor.current?.focus();
      }
    } finally {
      busy.current = false;
    }
  }

  function startEditing() {
    setStatus("");
    setFailure(null);
    setStale(false);
    setEdit({ body: question.latestAnswer?.body ?? "", baseVersion: question.latestAnswer?.version ?? 0 });
  }
  function cancel() {
    setFailure(null);
    setStale(false);
    resumeFocus.current = "trigger";
    setEdit(null);
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (edit && !stale) void save(edit, true);
  }

  return (
    <li className="min-w-0 space-y-3 rounded-[var(--radius-control)] border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        <Heading ref={heading} id={id} data-question-id={question.questionId} tabIndex={-1}
          className="min-w-0 flex-1 whitespace-pre-wrap break-words font-medium text-ink">{question.prompt}</Heading>
        <Badge tone={question.required && !question.latestAnswer ? "warning" : "neutral"}>{question.required ? "Required" : "Optional"}</Badge>
      </div>
      {question.latestAnswer ? (
        <div className="min-w-0 rounded-[var(--radius-control)] bg-surface-sunken p-3">
          <p className="text-xs font-medium text-muted">Answer version {question.latestAnswer.version} · <DateTime value={question.latestAnswer.answeredAt} /></p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-body">{question.latestAnswer.body}</p>
        </div>
      ) : <p className="text-sm text-muted">No answer yet.</p>}
      {editing && edit ? (
        <form aria-labelledby={id} onSubmit={submit} noValidate className="space-y-3">
          <Field label="Your answer" required hint="Up to 8,000 characters. Each saved edit creates a new version." error={failure}>
            <Textarea ref={editor} maxLength={MAX_ANSWER_LENGTH} value={edit.body} readOnly={write.isPending}
              onChange={(event) => { setEdit({ ...edit, body: event.target.value }); if (!stale) setFailure(null); }} />
          </Field>
          <div className="sr-only" role="alert">{failure}</div>
          <div className="flex flex-wrap gap-2">
            {stale ? <Button variant="secondary" onClick={() => {
              setEdit({ ...edit, baseVersion: question.latestAnswer?.version ?? 0 });
              setStale(false);
              setFailure(null);
              editor.current?.focus();
            }}>Use my draft with the latest version</Button> : <Button type="submit" loading={write.isPending}>Save answer</Button>}
            <Button variant="ghost" disabled={write.isPending} onClick={cancel}>Cancel</Button>
          </div>
        </form>
      ) : canAnswer ? (
        <Button ref={trigger} variant="secondary" aria-describedby={id} onClick={startEditing}>{question.latestAnswer ? "Edit answer" : "Answer question"}</Button>
      ) : null}
      <p className={status ? "text-sm text-body" : "sr-only"} role="status">{status}</p>
      {agreement && edit ? (
        <AgreementDialog open policyPublicId={agreement.policyPublicId} signatureMode={agreement.signatureMode}
          onAccepted={() => { setAgreement(null); void save(edit, false); }}
          onClose={() => { setAgreement(null); setFailure("Accept the agreement to save your answer."); }} />
      ) : null}
    </li>
  );
}

/** Customer wizard slot. The server (not readOnly) enforces phase and order access. */
export function StageQuestions({ orderId, stageKey, readOnly = false, headingLevel = 3 }: Scope & { readOnly?: boolean; headingLevel?: 3 | 4 }) {
  const trpc = useTRPC();
  const scope = { orderId, stageKey };
  const id = useId();
  const query = useQuery(trpc.orders.questions.customerList.queryOptions(scope));
  const SectionHeading = headingLevel === 4 ? "h4" : "h3";
  const QuestionHeading = headingLevel === 4 ? "h5" : "h4";
  return (
    <section aria-labelledby={id} className="ph-no-capture min-w-0 space-y-3" data-clarity-mask="true">
      <SectionHeading id={id} className="font-semibold text-ink">Questions from our team</SectionHeading>
      {query.isPending ? <><p role="status" className="sr-only">Loading questions</p><Skeleton className="h-20 w-full" /></> : query.isError ? (
        <Callout tone="danger" live="assertive" title="Could not load questions">
          <p>{errorMessage(query.error)}</p>
          <Button variant="secondary" onClick={() => void query.refetch()}>Retry</Button>
        </Callout>
      ) : query.data.questions.length === 0 ? (
        <p className="text-sm text-muted">No questions have been assigned to this phase.</p>
      ) : (
        <>
          {!readOnly && query.data.canAnswer ? <p className="text-sm text-muted">Save an answer for each required question before continuing.</p>
            : <p className="text-sm text-muted">You can read saved answers, but cannot edit them.</p>}
          <ul className="space-y-3">
            {query.data.questions.map((question) => <CustomerQuestion key={question.questionId} scope={scope} question={question}
              Heading={QuestionHeading} canAnswer={!readOnly && query.data.canAnswer} />)}
          </ul>
        </>
      )}
    </section>
  );
}
