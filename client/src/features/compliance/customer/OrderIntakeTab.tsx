import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { IntakeAnswerMap, IntakeAnswerValue } from "@server/modules/compliance/domain";
import type { IntakeRevisionView, OrderIntakeItemView } from "@server/modules/compliance/intakeService";
import type { StoredIntakeFieldDef } from "@server/modules/compliance/schema";
import { errorMessage, safeError, useTRPC } from "@/lib/trpc";
import { Button, Callout, Card, Checkbox, DateTime, EmptyState, ErrorState, Field, Input, KeyValueList, LoadMore, Select, Skeleton, Textarea } from "@/ui";
import { IntakeStatusBadge } from "../shared";
import { intakeFieldErrors, prepareAnswers, type FieldErrors } from "./intakeModel";

function AnswerFields({ field, value, error, onChange }: {
  field: StoredIntakeFieldDef;
  value: IntakeAnswerValue | undefined;
  error: string | undefined;
  onChange: (value: IntakeAnswerValue) => void;
}) {
  const id = useId();
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  if (field.type === "multi_choice") {
    const selected: readonly string[] = Array.isArray(value) ? value : [];
    const describedBy = [field.helpText && `${id}-help`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
    return <fieldset tabIndex={error ? -1 : undefined} aria-describedby={describedBy} aria-invalid={error ? true : undefined}
      className="min-w-0 space-y-2 rounded-[var(--radius-control)] border border-line px-3 py-2 aria-invalid:border-danger">
      <legend className="max-w-full break-words px-1 text-sm font-medium text-ink">{field.label}{field.required ? " (required)" : ""}</legend>
      {field.helpText ? <p id={`${id}-help`} className="text-sm text-muted">{field.helpText}</p> : null}
      {error ? <p id={`${id}-error`} className="text-sm font-medium text-danger">{error}</p> : null}
      {(field.options ?? []).map((option) => <Checkbox key={option.value} label={option.label} checked={selected.includes(option.value)}
        onCheckedChange={(checked) => onChange(checked ? [...selected, option.value] : selected.filter((entry) => entry !== option.value))} />)}
    </fieldset>;
  }
  return <Field label={field.label} hint={field.helpText} error={error} required={field.required}>
    {field.type === "long_text"
      ? <Textarea value={text} maxLength={field.maxLength ?? 8000} onChange={(e) => onChange(e.target.value)} autoComplete="off" />
      : field.type === "single_choice"
        ? <Select value={text} options={field.options ?? []} placeholder="Choose an option" onChange={(e) => onChange(e.target.value)} />
        : <Input value={text} type={field.type === "date" ? "date" : "text"} inputMode={field.type === "number" ? "decimal" : undefined}
          maxLength={field.type === "short_text" ? (field.maxLength ?? 500) : field.type === "number" ? 32 : undefined}
          onChange={(e) => onChange(e.target.value)} autoComplete="off" />}
  </Field>;
}

function AnswerSummary({ fields, answers }: { fields: readonly StoredIntakeFieldDef[]; answers: IntakeAnswerMap }) {
  return <KeyValueList items={fields.map((field) => {
    const answer = Object.hasOwn(answers, field.key) ? answers[field.key] : null;
    const label = (value: string | number) => field.options?.find((option) => option.value === value)?.label ?? String(value);
    const value = answer === null || answer === undefined || answer === "" || (Array.isArray(answer) && !answer.length) ? "Not answered"
      : typeof answer === "string" || typeof answer === "number" ? label(answer) : answer.map(label).join(", ");
    return { label: field.label, value: <span className="whitespace-pre-wrap">{value}</span>, wide: field.type === "long_text" };
  })} />;
}

const revisionLabels: Record<IntakeRevisionView["eventKind"], string> = {
  draft_saved: "Draft saved", submitted: "Submitted", returned_for_changes: "Returned for changes", accepted: "Accepted", imported: "Imported",
};

function RevisionHistory({ orderId, item }: { orderId: string; item: OrderIntakeItemView }) {
  const trpc = useTRPC();
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const history = useInfiniteQuery(trpc.compliance.intake.getSubmission.infiniteQueryOptions({
    orderPublicId: orderId, questionnairePublicId: item.questionnairePublicId, limit: 10,
  }, { enabled: expanded, getNextPageParam: (page) => page.nextCursor ?? undefined }));
  const revisions = history.data?.pages.flatMap((page) => page.revisions) ?? [];
  return <div className="space-y-3 border-t border-line pt-4">
    <Button variant="secondary" size="sm" onClick={() => setExpanded((open) => !open)} aria-expanded={expanded} aria-controls={id}>
      {expanded ? "Hide revision history" : "Show revision history"}
    </Button>
    <div id={id} hidden={!expanded}>
      {expanded ? history.isPending ? <Skeleton lines={3} /> : history.isError && !history.data
        ? <ErrorState title="We couldn't load revision history" onRetry={() => void history.refetch()} />
        : <div className="space-y-3">
          {revisions.length ? <ol className="space-y-3">
            {revisions.map((revision) => <li key={revision.revisionPublicId} className="rounded-[var(--radius-control)] border border-line p-3">
              <p className="font-medium text-ink">Revision {revision.revisionNumber}: {revisionLabels[revision.eventKind]}</p>
              <p className="text-sm text-muted"><DateTime value={revision.occurredAt} /> · {revision.actorRole}</p>
              {revision.reviewNote ? <p className="mt-2 whitespace-pre-wrap break-words text-body">{revision.reviewNote}</p> : null}
              <details className="mt-2">
                <summary className="min-h-11 cursor-pointer py-2 text-action">Answers in revision {revision.revisionNumber}</summary>
                <AnswerSummary fields={item.boundVersion.fields} answers={revision.answers} />
              </details>
            </li>)}
          </ol> : <p className="text-body">No revisions have been recorded.</p>}
          {history.isFetchNextPageError ? <Callout tone="danger" live="polite">Couldn't load more revisions. Try again.</Callout> : null}
          <LoadMore hasMore={history.hasNextPage} loading={history.isFetchingNextPage} onLoadMore={() => void history.fetchNextPage()} label="Load more revisions" />
        </div> : null}
    </div>
  </div>;
}

function Questionnaire({ item, orderId, locked }: { item: OrderIntakeItemView; orderId: string; locked: boolean }) {
  const trpc = useTRPC();
  const client = useQueryClient();
  const save = useMutation(trpc.compliance.intake.saveDraft.mutationOptions());
  const submit = useMutation(trpc.compliance.intake.submit.mutationOptions());
  const [edits, setEdits] = useState<IntakeAnswerMap>({});
  const [basis, setBasis] = useState<number | null>(null);
  const [error, setError] = useState<{ message: string; fields: FieldErrors }>();
  const [focusRequest, setFocusRequest] = useState(0);
  const [success, setSuccess] = useState<string>();
  const [working, setWorking] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const active = useRef(false);
  const data = item.submission;
  const fields = item.boundVersion.fields;
  const editable = !locked && item.canWrite;
  const stale = basis !== null && basis !== (data?.revisionNumber ?? 0);
  const answers: IntakeAnswerMap = { ...data?.answers, ...edits };
  const sections: Array<{ title: string | undefined; fields: StoredIntakeFieldDef[] }> = [];
  for (const field of fields) {
    const previous = sections[sections.length - 1];
    if (previous && previous.title === field.section) previous.fields.push(field);
    else sections.push({ title: field.section, fields: [field] });
  }
  useEffect(() => {
    if (!focusRequest) return;
    const firstInvalid = form.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    (firstInvalid ?? form.current?.querySelector<HTMLElement>("[data-intake-error]"))?.focus();
  }, [focusRequest]);

  async function refresh() {
    await Promise.all([
      client.invalidateQueries({ queryKey: trpc.compliance.intake.listForOrder.queryKey({ orderPublicId: orderId }) }),
      client.invalidateQueries({ queryKey: trpc.compliance.intake.getSubmission.pathKey() }),
    ]);
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editable || stale || active.current) return;
    const intent = (event.nativeEvent as SubmitEvent).submitter;
    const final = intent instanceof HTMLButtonElement && intent.value === "submit";
    setSuccess(undefined);
    const validated = prepareAnswers(fields, answers, final);
    if (Object.keys(validated.errors).length) {
      setError({ message: "Check the highlighted answers.", fields: validated.errors });
      setFocusRequest((request) => request + 1);
      return;
    }
    active.current = true;
    setWorking(true);
    setError(undefined);
    try {
      await (final ? submit : save).mutateAsync({ orderPublicId: orderId, questionnairePublicId: item.questionnairePublicId, answers: validated.answers });
      setEdits({});
      setBasis(null);
      setSuccess(final ? "Questionnaire submitted for review." : "Draft saved.");
      await refresh();
    } catch (failure) {
      setError({
        message: errorMessage(failure, "We couldn't confirm this change. Check the latest status before trying again."),
        fields: intakeFieldErrors(failure, fields),
      });
      setFocusRequest((request) => request + 1);
      const domain = safeError(failure)?.domainCode;
      if (domain !== "VALIDATION" && domain !== "BAD_INPUT") await refresh();
    } finally {
      active.current = false;
      setWorking(false);
    }
  }

  return <Card title={item.title} description={item.description ?? `Questionnaire version ${item.boundVersion.versionNumber}`}
    actions={<IntakeStatusBadge status={data?.status ?? "not_started"} />}>
    <div className="space-y-4">
      {data?.latestReviewNote ? <Callout title="Reviewer feedback"><p className="whitespace-pre-wrap break-words">{data.latestReviewNote}</p></Callout> : null}
      {success ? <Callout tone="success" live="polite">{success}</Callout> : null}
      {!editable && error ? <Callout tone="danger" live="polite">{error.message}</Callout> : null}
      {editable ? <form ref={form} noValidate onSubmit={(event) => void send(event)} className="space-y-4">
        {error ? <div data-intake-error tabIndex={-1}><Callout tone="danger" live="assertive">{error.message}</Callout></div> : null}
        {stale ? <Callout tone="warning" title="A newer revision exists" actions={
          <Button variant="secondary" onClick={() => { setEdits({}); setBasis(null); setError(undefined); }}>Discard my edits and load latest revision</Button>
        }>Reload the saved answers before editing again to avoid replacing a newer revision.</Callout> : null}
        <fieldset disabled={working || stale} className="min-w-0 space-y-5">
          {sections.map((section, index) => <div key={index} className="space-y-3">
            {section.title ? <h3 className="break-words text-base font-semibold text-ink">{section.title}</h3> : null}
            {section.fields.map((field) => <AnswerFields key={field.key} field={field} value={answers[field.key]} error={error?.fields[field.key]}
              onChange={(value) => {
                setBasis((previous) => previous ?? (data?.revisionNumber ?? 0));
                setEdits((previous) => ({ ...previous, [field.key]: value }));
                setSuccess(undefined);
                setError((previous) => previous?.fields[field.key]
                  ? { ...previous, fields: { ...previous.fields, [field.key]: "" } } : previous);
              }} />)}
          </div>)}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" value="draft" variant="secondary" loading={save.isPending}>Save draft</Button>
            <Button type="submit" value="submit" loading={submit.isPending}>Submit questionnaire</Button>
          </div>
        </fieldset>
      </form> : <>
        <p className="text-sm text-muted">{locked ? "This questionnaire is read-only while the order is locked." : "This questionnaire is read-only."}</p>
        <AnswerSummary fields={fields} answers={data?.answers ?? {}} />
      </>}
      {data ? <RevisionHistory item={item} orderId={orderId} /> : null}
    </div>
  </Card>;
}

export default function OrderIntakeTab({ orderId }: { orderId: string; area: "customer" | "console" }) {
  const trpc = useTRPC();
  const intake = useQuery(trpc.compliance.intake.listForOrder.queryOptions({ orderPublicId: orderId }));
  if (intake.isPending) return <Skeleton lines={4} />;
  if (intake.isError) return <ErrorState title="We couldn't load order questionnaires" onRetry={() => void intake.refetch()} />;
  if (!intake.data.items.length) return <EmptyState title="No questionnaires for this order" description="Any applicable questionnaires will appear here." />;
  const locked = intake.data.lockState !== "none";
  return <div className="grid gap-4">
    {intake.data.items.map((item) => <Questionnaire key={`${orderId}:${item.questionnairePublicId}:${item.boundVersion.versionPublicId}`}
      item={item} orderId={orderId} locked={locked} />)}
  </div>;
}
