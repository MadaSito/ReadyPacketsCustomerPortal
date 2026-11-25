/**
 * Workflow designer (/admin/workflows/drafts/:draftId). Owner: orders_engineer.
 * The wizard and the canvas are two views of ONE draft held here. Every save returns the server's issues; the
 * server is the only authority on validity and refuses to publish a draft with errors. Publishing needs step-up.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "wouter";
import { errorMessage, safeError, useTRPC } from "@/lib/trpc";
import {
  Badge,
  Breadcrumbs,
  Button,
  Callout,
  Card,
  Checkbox,
  DataTable,
  ErrorState,
  Field,
  FlowCanvas,
  IconButton,
  Input,
  PageHeader,
  Select,
  Skeleton,
  StepUpCancelledError,
  Tabs,
  Textarea,
  useStepUp,
  useToast,
  Wizard,
  type FlowSelection,
} from "@/ui";
import { PhaseEditor, type PhaseStatusOption } from "@/ui/phases";
import { PHASE_FORM_SLOTS } from "@/app/slots";
import { deriveStages, type WorkflowStage } from "@shared/workflowStages";
import { OrderStatusBadge } from "../../shared";
import { IssueList, StatusFields, TransitionNoticeFields, TransitionRouteFields, TransitionWhoFields } from "./fields";
import {
  ACTOR_LABEL,
  addState,
  edgeId,
  errorsOf,
  indexOfId,
  issueFieldId,
  KIND_LABEL,
  moveState,
  newTransition,
  nodeId,
  positionOf,
  removeState,
  removeTransition,
  setPosition,
  stateLabel,
  stepOfIssue,
  updateState,
  updateTransition,
  WIZARD_STEPS,
  type DraftDefinition,
  type DraftState,
  type DraftTransition,
  type DraftView,
  type Layout,
  type WizardStepId,
  type WorkflowIssue,
} from "./model";
import { AcceptanceGatesEditor, PhasesEditor, RulesReviewSummary, StateRulesFields, StorageFolderEditor } from "./rulesFields";

export default function WorkflowDesignerPage() {
  const { draftId = "" } = useParams<{ draftId: string }>();
  const trpc = useTRPC();
  const draft = useQuery({ ...trpc.orders.admin.workflows.drafts.get.queryOptions({ draftId }), refetchOnWindowFocus: false });
  const crumbs = <Breadcrumbs items={[{ label: "Workflows", href: "/admin/workflows" }, { label: draft.data ? `Draft: ${draft.data.name}` : "Draft" }]} />;
  if (draft.isPending)
    return (
      <>
        <PageHeader title="Workflow draft" breadcrumbs={crumbs} />
        <Skeleton lines={8} />
      </>
    );
  if (draft.error)
    return (
      <>
        <PageHeader title="Workflow draft" breadcrumbs={crumbs} />
        <ErrorState error={draft.error} onRetry={() => void draft.refetch()} />
      </>
    );
  // Keyed by draft so a different draft never inherits local edits.
  return <DraftEditor key={draft.data.publicId} initial={draft.data} breadcrumbs={crumbs} />;
}

type Editable = { name: string; definition: DraftDefinition; layout: Layout };

function DraftEditor({ initial, breadcrumbs }: { initial: DraftView; breadcrumbs: React.ReactNode }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();
  const stepUp = useStepUp();
  const [, navigate] = useLocation();
  const save = useMutation(trpc.orders.admin.workflows.drafts.save.mutationOptions());
  const publish = useMutation(trpc.orders.admin.workflows.drafts.publish.mutationOptions());

  const [work, setWork] = useState<Editable>({ name: initial.name, definition: initial.definition, layout: initial.layout ?? { nodes: [] } });
  const [rowVersion, setRowVersion] = useState(initial.rowVersion);
  const [issues, setIssues] = useState<WorkflowIssue[]>(initial.issues);
  const [publishable, setPublishable] = useState(initial.publishable);
  const [dirty, setDirty] = useState(false);
  const edits = useRef(0);
  // Increment 07 QA: every draft opens on Phases (phases-first); a draft without phases shows how to start them.
  const [tab, setTab] = useState("phases");
  const [step, setStep] = useState<WizardStepId>("statuses");
  const [visited, setVisited] = useState<WizardStepId[]>([]);
  const [stepBlocked, setStepBlocked] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [makeDefault, setMakeDefault] = useState(false);
  const [changeNote, setChangeNote] = useState("");

  const edit = (next: (current: Editable) => Editable) => {
    edits.current += 1;
    setDirty(true);
    setStepBlocked(false);
    setWork(next);
  };
  const setDefinition = (definition: DraftDefinition) => edit((current) => ({ ...current, definition }));

  /** Saves the current draft; resolves to the server's issues, or null when the save failed (message shown). */
  const saveNow = async (): Promise<WorkflowIssue[] | null> => {
    const snapshot = work;
    const editMark = edits.current;
    setProblem(null);
    if (!snapshot.name.trim()) {
      setProblem("Enter a name for the workflow.");
      return null;
    }
    try {
      const result = await save.mutateAsync({ draftId: initial.publicId, expectedVersion: rowVersion, name: snapshot.name.trim(), definition: snapshot.definition, layout: snapshot.layout });
      setRowVersion(result.rowVersion);
      setIssues(result.issues);
      setPublishable(result.publishable);
      if (edits.current === editMark) setDirty(false);
      void queryClient.invalidateQueries({ queryKey: trpc.orders.admin.workflows.drafts.list.queryKey() });
      return result.issues;
    } catch (err) {
      setProblem(errorMessage(err, "The draft could not be saved. Please try again."));
      return null;
    }
  };

  const onSaveClick = async () => {
    const result = await saveNow();
    if (result) toast.show({ tone: "success", title: "Draft saved", description: errorsOf(result).length ? `${errorsOf(result).length} problem(s) still to fix before publishing.` : "Ready to publish." });
  };

  const doPublish = async () => {
    const saved = dirty ? await saveNow() : issues;
    if (!saved) return;
    if (errorsOf(saved).length) {
      setProblem("Fix the problems listed below before publishing.");
      return;
    }
    setProblem(null);
    try {
      const result = await stepUp.run(
        () => publish.mutateAsync({ draftId: initial.publicId, expectedVersion: rowVersion, makeDefault, ...(changeNote.trim() ? { changeNote: changeNote.trim() } : {}) }),
        { reason: "Publishing a workflow changes how new orders move." },
      );
      toast.show({ tone: "success", title: `Version ${result.versionNumber} published`, description: "New orders use it. Existing orders keep the version they started on." });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: trpc.orders.admin.workflows.list.queryKey() }),
        queryClient.invalidateQueries({ queryKey: trpc.orders.admin.workflows.drafts.list.queryKey() }),
      ]);
      navigate(`/admin/workflows/${result.workflowPublicId}/versions`);
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      // WORKFLOW_DRAFT_INVALID carries parallel arrays: messages, field paths and codes (all errors).
      const details = safeError(err)?.details as { issues?: unknown; issuePaths?: unknown; issueCodes?: unknown } | undefined;
      if (Array.isArray(details?.issues)) {
        const paths = Array.isArray(details.issuePaths) ? details.issuePaths : [];
        const codes = Array.isArray(details.issueCodes) ? details.issueCodes : [];
        setIssues(details.issues.map((message, i) => ({ severity: "error" as const, message: String(message), path: String(paths[i] ?? ""), code: String(codes[i] ?? "") })));
        setPublishable(false);
      }
      setProblem(errorMessage(err, "The workflow could not be published. Please try again."));
    }
  };

  const stepIndex = WIZARD_STEPS.findIndex((s) => s.id === step);
  const stepIssues = (id: WizardStepId) => (id === "review" ? issues : issues.filter((issue) => stepOfIssue(issue) === id));
  const goTo = (id: WizardStepId) => {
    setStepBlocked(false);
    setStep(id);
  };
  const onNext = async () => {
    if (step === "review") return void doPublish();
    const result = await saveNow();
    if (!result) return;
    if (errorsOf(result.filter((issue) => stepOfIssue(issue) === step)).length) {
      setStepBlocked(true);
      return;
    }
    setVisited((current) => (current.includes(step) ? current : [...current, step]));
    goTo(WIZARD_STEPS[stepIndex + 1]!.id);
  };

  /**
   * Increment 06: findings jump to the field. Opens the wizard step that owns the problem, then focuses the exact
   * control (by its path id), or a control whose error text matches, or that step's problem list.
   */
  const [findingsOpen, setFindingsOpen] = useState(false);
  const jump = (issue: WorkflowIssue) => {
    setTab("wizard");
    goTo(stepOfIssue(issue));
    const focusTarget = (attempt: number) => {
      const exact = issue.path ? document.getElementById(issueFieldId(issue.path)) : null;
      const byMessage = exact
        ? null
        : Array.from(document.querySelectorAll<HTMLElement>("[aria-invalid='true']")).find((element) =>
            (element.getAttribute("aria-describedby") ?? "").split(" ").some((id) => id && document.getElementById(id)?.textContent?.includes(issue.message)),
          );
      const target = exact ?? byMessage ?? document.getElementById("wf-step-problems");
      if (!target && attempt < 5) return void window.setTimeout(() => focusTarget(attempt + 1), 30);
      if (!target) return;
      target.scrollIntoView?.({ block: "center", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      target.focus({ preventScroll: true });
    };
    window.setTimeout(() => focusTarget(0), 0);
  };

  const busy = save.isPending || publish.isPending;
  const saveButton = (
    <Button variant="ghost" onClick={() => void onSaveClick()} loading={save.isPending} disabled={busy}>
      Save draft
    </Button>
  );
  const errorCount = errorsOf(issues).length;
  const warningCount = issues.length - errorCount;

  return (
    <>
      <PageHeader
        title={work.name.trim() || "Untitled workflow"}
        breadcrumbs={breadcrumbs}
        description={
          initial.workflowPublicId
            ? `Draft of a new version${initial.baseVersionNumber ? ` (based on version ${initial.baseVersionNumber})` : ""}. Publishing creates a new version; existing orders keep theirs.`
            : "Draft of a new workflow. Nothing changes for orders until you publish."
        }
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">{initial.workflowKey}</Badge>
            {dirty ? <Badge tone="warning">Unsaved changes</Badge> : <Badge tone="neutral">Saved</Badge>}
            {errorCount ? (
              <Button size="sm" variant="secondary" aria-expanded={findingsOpen} aria-controls="wf-findings" onClick={() => setFindingsOpen((open) => !open)}>
                <Badge tone="danger">{`${errorCount} to fix`}</Badge>
                <span>{findingsOpen ? "Hide problems" : "Show problems"}</span>
              </Button>
            ) : (
              <Badge tone="success">No problems</Badge>
            )}
            {warningCount ? <Badge tone="warning">{`${warningCount} warning${warningCount === 1 ? "" : "s"}`}</Badge> : null}
          </div>
        }
        actions={saveButton}
      />
      <div className="flex flex-col gap-6">
        <div id="wf-findings" hidden={!findingsOpen || issues.length === 0}>
          {findingsOpen ? <IssueList issues={issues} title={`Problems in this draft (${issues.length}). Choose Show to go to each one.`} onJump={jump} /> : null}
        </div>
        {problem ? (
          <Callout tone="danger" live="assertive">
            {problem}
          </Callout>
        ) : null}
        <Field label="Workflow name" required>
          <Input value={work.name} maxLength={120} onChange={(event) => edit((current) => ({ ...current, name: event.target.value }))} className="max-w-xl" />
        </Field>
        <Tabs
          label="Designer view"
          value={tab}
          onValueChange={setTab}
          items={[
            { value: "phases", label: "Phases", content: <PhasesView definition={work.definition} issues={issues} disabled={busy} setDefinition={setDefinition} /> },
            {
              value: "wizard",
              label: "Statuses wizard",
              content: (
                <Wizard
                  steps={WIZARD_STEPS.map((s) => ({ id: s.id, label: s.label }))}
                  current={step}
                  onNext={() => void onNext()}
                  onBack={stepIndex > 0 ? () => goTo(WIZARD_STEPS[stepIndex - 1]!.id) : undefined}
                  onStepSelect={(id) => goTo(id as WizardStepId)}
                  completed={visited}
                  nextLabel={step === "review" ? "Publish" : "Save and continue"}
                  nextDisabled={step === "review" && (busy || (!dirty && !publishable))}
                  busy={busy}
                  secondaryAction={step === "review" ? null : saveButton}
                >
                  <StepBody
                    step={step}
                    work={work}
                    issues={issues}
                    stepIssues={stepIssues(step)}
                    blocked={stepBlocked}
                    edit={edit}
                    setDefinition={setDefinition}
                    makeDefault={makeDefault}
                    setMakeDefault={setMakeDefault}
                    newWorkflow={initial.workflowPublicId === null}
                    changeNote={changeNote}
                    setChangeNote={setChangeNote}
                    publishable={publishable && !dirty}
                    dirty={dirty}
                    onJump={jump}
                  />
                </Wizard>
              ),
            },
            { value: "canvas", label: "Canvas", content: <CanvasView work={work} issues={issues} edit={edit} setDefinition={setDefinition} /> },
          ]}
        />
      </div>
    </>
  );
}

/**
 * Increment 07 QA: phases derived from the statuses (or their classic groups); the classic groups are removed in the
 * same step, since a draft may not use both (STAGES_WITH_PHASES). Exported for tests.
 */
export function startPhases(definition: DraftDefinition): DraftDefinition {
  const stages = deriveStages(definition);
  const { phases: _classic, ...rest } = definition;
  return { ...rest, states: definition.states.map(({ phase: _group, ...state }) => state), stages } as DraftDefinition;
}

type CatalogStatus = { key: string; staffLabel: string; customerLabel: string; tone: string; category: string; retired: boolean };

/**
 * Increment 07 QA: a phase that names a catalogue status the draft does not have adds that status to the draft
 * (labels and tone from the catalogue, no transitions). Publishing still reports it until it has transitions.
 * Exported for tests.
 */
export function addCatalogStatuses(definition: DraftDefinition, catalog: readonly CatalogStatus[]): { definition: DraftDefinition; added: string[] } {
  const have = new Set(definition.states.map((state) => state.key));
  const wanted = ((definition.stages ?? []) as { statusKeys?: string[] }[]).flatMap((stage) => stage.statusKeys ?? []);
  const added: string[] = [];
  const states = [...definition.states];
  for (const key of wanted) {
    if (have.has(key)) continue;
    const entry = catalog.find((item) => item.key === key && !item.retired);
    if (!entry) continue;
    have.add(key);
    added.push(key);
    const kind = entry.category === "done" || entry.category === "canceled" ? "terminal" : "active";
    states.push({ key, label: entry.staffLabel, customerLabel: entry.customerLabel, kind, tone: entry.tone } as DraftDefinition["states"][number]);
  }
  return { definition: added.length ? ({ ...definition, states } as DraftDefinition) : definition, added };
}

/** Increment 07 (D1): the phase editor (package A) over `definition.stages`; the server validates on save. */
function PhasesView(props: { definition: DraftDefinition; issues: WorkflowIssue[]; disabled: boolean; setDefinition: (definition: DraftDefinition) => void }) {
  const { definition, issues, disabled, setDefinition } = props;
  const trpc = useTRPC();
  const catalog = useQuery(trpc.orders.statusCatalog.list.queryOptions({ includeRetired: true }, { retry: false, staleTime: 60_000 }));
  const stages = (definition.stages ?? []) as WorkflowStage[];
  // This workflow's statuses first, with this workflow's labels; then catalogue statuses the workflow does not have
  // yet. Ticking one of those adds it to the draft (see addCatalogStatuses), so saving never fails on it.
  const catalogItems = catalog.data ?? [];
  const catalogByKey = new Map(catalogItems.map((entry) => [entry.key, entry]));
  const used = new Set(definition.states.map((state) => state.key));
  const statusOptions: PhaseStatusOption[] = [
    ...definition.states
      .filter((state) => state.key.trim())
      .map((state) => {
        const entry = catalogByKey.get(state.key);
        return { key: state.key, label: state.label.trim() || entry?.staffLabel || state.key, ...(entry ? { category: entry.category, retired: entry.retired } : {}) };
      }),
    ...catalogItems
      .filter((entry) => !entry.retired && !used.has(entry.key))
      .map((entry) => ({ key: entry.key, label: `${entry.staffLabel} (not in this workflow yet)`, category: entry.category })),
  ];
  const [added, setAdded] = useState<string[]>([]);
  const errors: Record<string, string> = {};
  for (const issue of issues) if (issue.severity === "error" && /^stages(\.|$)/.test(issue.path) && !errors[issue.path]) errors[issue.path] = issue.message;
  const setStages = (next: WorkflowStage[]) => {
    const result = addCatalogStatuses({ ...definition, stages: next } as DraftDefinition, catalogItems);
    if (result.added.length) setAdded((prior) => [...prior, ...result.added.filter((key) => !prior.includes(key))]);
    setDefinition(result.definition);
  };
  const addedLabels = added.filter((key) => used.has(key)).map((key) => definition.states.find((state) => state.key === key)?.label || key);
  if (!stages.length)
    return (
      <Card>
        <div className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-ink">Phases</h2>
          <p className="text-body">
            This draft has no phases yet. Customers then see progress by status, as before. Start phases from the statuses below,
            then review each phase before you publish. Existing orders keep the version they started with.
          </p>
          <div>
            <Button variant="secondary" disabled={disabled || definition.states.length === 0} onClick={() => setDefinition(startPhases(definition))}>
              Start phases from statuses
            </Button>
          </div>
        </div>
      </Card>
    );
  return (
    <div className="flex flex-col gap-3">
      <div aria-live="polite">
        {addedLabels.length ? (
          <Callout tone="info">{`${addedLabels.join(", ")}: added to this workflow's statuses. Add its transitions in the Statuses wizard.`}</Callout>
        ) : null}
      </div>
      <PhaseEditor
        value={stages}
        onChange={setStages}
        statusOptions={statusOptions}
        errors={errors}
        disabled={disabled}
        slots={PHASE_FORM_SLOTS}
        defaultView="canvas"
        headingLevel={2}
      />
    </div>
  );
}

interface StepBodyProps {
  step: WizardStepId;
  work: Editable;
  issues: WorkflowIssue[];
  stepIssues: WorkflowIssue[];
  blocked: boolean;
  edit: (next: (current: Editable) => Editable) => void;
  setDefinition: (definition: DraftDefinition) => void;
  makeDefault: boolean;
  setMakeDefault: (value: boolean) => void;
  /** Increment 07.2: the draft proposes a new workflow (not a new version of a published one). */
  newWorkflow: boolean;
  changeNote: string;
  setChangeNote: (value: string) => void;
  publishable: boolean;
  dirty: boolean;
  onJump?: (issue: WorkflowIssue) => void;
}

function StepBody(props: StepBodyProps) {
  const { step, work, issues, stepIssues, blocked, edit, setDefinition } = props;
  const { definition } = work;
  const intro: Record<WizardStepId, string> = {
    statuses: "The steps an order goes through. Exactly one is where orders start; at least one is final.",
    transitions: "Which moves are possible. Every status except a final one needs a way out.",
    who: "Who may make each move. The server enforces this for every request.",
    notices: "Whether the customer is told about each move, and whether the person moving it must write a note.",
    rules: "Optional. List what must be uploaded or accepted before an order can leave a status. Workflows without phases can also group statuses so a group locks when the order leaves it. Publishing these rules needs the workflow rules setting turned on in Settings.",
    review: "Check the summary, then publish. Orders already in progress keep the version they started on.",
  };
  const problems =
    step === "review" ? null : (
      <div id="wf-step-problems" tabIndex={-1} className="outline-none">
        <IssueList
          issues={stepIssues}
          live={blocked}
          title={blocked ? "Fix these problems to continue" : "Problems found when the draft was last saved"}
          onJump={props.onJump}
        />
      </div>
    );
  const noTransitions = definition.transitions.length === 0 && step !== "statuses" && step !== "transitions" && step !== "rules" && step !== "review";

  return (
    <div className="flex flex-col gap-5">
      <p className="text-body">{intro[step]}</p>
      {problems}
      {noTransitions ? <Callout tone="info">Add transitions in the Transitions step first.</Callout> : null}

      {step === "statuses" ? (
        <>
          <ol className="flex flex-col gap-4">
            {definition.states.map((state, index) => (
              <li key={index}>
                <fieldset className="rounded-[var(--radius-card)] border border-line p-4">
                  <legend className="px-1 text-sm font-semibold text-ink">{`Status ${index + 1}: ${state.label.trim() || "(no label)"}`}</legend>
                  <StatusFields state={state} index={index} issues={issues} onChange={(patch) => edit((current) => ({ ...current, ...updateState(current.definition, current.layout, index, patch) }))} />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <IconButton label={`Move ${state.label || `status ${index + 1}`} up`} icon={<ArrowUp aria-hidden="true" />} size="sm" variant="ghost" disabled={index === 0} onClick={() => setDefinition(moveState(definition, index, -1))} />
                    <IconButton label={`Move ${state.label || `status ${index + 1}`} down`} icon={<ArrowDown aria-hidden="true" />} size="sm" variant="ghost" disabled={index === definition.states.length - 1} onClick={() => setDefinition(moveState(definition, index, 1))} />
                    <Button size="sm" variant="ghost" aria-label={`Remove ${state.label || `status ${index + 1}`}`} onClick={() => edit((current) => ({ ...current, ...removeState(current.definition, current.layout, index) }))}>
                      <Trash2 aria-hidden="true" className="size-4" />
                      Remove
                    </Button>
                  </div>
                </fieldset>
              </li>
            ))}
          </ol>
          <div>
            <Button variant="secondary" disabled={definition.states.length >= 30} onClick={() => edit((current) => { const added = addState(current.definition, current.layout); return { ...current, definition: added.definition, layout: added.layout }; })}>
              <Plus aria-hidden="true" className="size-4" />
              Add status
            </Button>
          </div>
        </>
      ) : null}

      {step === "transitions" ? (
        <>
          {definition.transitions.length === 0 ? <p className="text-body">No transitions yet.</p> : null}
          <ol className="flex flex-col gap-4">
            {definition.transitions.map((transition, index) => (
              <li key={index}>
                <fieldset className="rounded-[var(--radius-card)] border border-line p-4">
                  <legend className="px-1 text-sm font-semibold text-ink">{`Transition ${index + 1}: ${stateLabel(definition, transition.from)} to ${stateLabel(definition, transition.to)}`}</legend>
                  <TransitionRouteFields definition={definition} transition={transition} index={index} issues={issues} onChange={(patch) => setDefinition(updateTransition(definition, index, patch))} />
                  <div className="mt-3">
                    <Button size="sm" variant="ghost" aria-label={`Remove transition ${index + 1}`} onClick={() => setDefinition(removeTransition(definition, index))}>
                      <Trash2 aria-hidden="true" className="size-4" />
                      Remove
                    </Button>
                  </div>
                </fieldset>
              </li>
            ))}
          </ol>
          <div>
            <Button
              variant="secondary"
              disabled={definition.transitions.length >= 200}
              onClick={() => setDefinition({ ...definition, transitions: [...definition.transitions, newTransition(definition.states[0]?.key ?? "", definition.states[1]?.key ?? "")] })}
            >
              <Plus aria-hidden="true" className="size-4" />
              Add transition
            </Button>
          </div>
        </>
      ) : null}

      {step === "who" ? (
        <ol className="flex flex-col gap-4">
          {definition.transitions.map((transition, index) => (
            <li key={index} className="rounded-[var(--radius-card)] border border-line p-4">
              <TransitionWhoFields definition={definition} transition={transition} index={index} issues={issues} onChange={(patch) => setDefinition(updateTransition(definition, index, patch))} />
            </li>
          ))}
        </ol>
      ) : null}

      {step === "notices" ? (
        <ol className="flex flex-col gap-4">
          {definition.transitions.map((transition, index) => (
            <li key={index} className="rounded-[var(--radius-card)] border border-line p-4">
              <TransitionNoticeFields definition={definition} transition={transition} index={index} issues={issues} onChange={(patch) => setDefinition(updateTransition(definition, index, patch))} />
            </li>
          ))}
        </ol>
      ) : null}

      {step === "rules" ? (
        <>
          {definition.stages?.length ? (
            <Callout tone="info">This workflow uses phases, so status groups and their locks are set on the Phases tab. The requirements below still apply to each status.</Callout>
          ) : (
            <PhasesEditor definition={definition} issues={issues} onChange={setDefinition} />
          )}
          <AcceptanceGatesEditor definition={definition} issues={issues} onChange={setDefinition} />
          <StorageFolderEditor definition={definition} issues={issues} onChange={setDefinition} />
          <ol className="flex flex-col gap-4">
            {definition.states.map((state, index) => (
              <li key={index}>
                <fieldset className="rounded-[var(--radius-card)] border border-line p-4">
                  <legend className="px-1 text-sm font-semibold text-ink">{`Status ${index + 1}: ${state.label.trim() || "(no label)"}`}</legend>
                  <StateRulesFields definition={definition} state={state} index={index} issues={issues} onChange={(patch) => edit((current) => ({ ...current, ...updateState(current.definition, current.layout, index, patch) }))} />
                </fieldset>
              </li>
            ))}
          </ol>
        </>
      ) : null}

      {step === "review" ? <ReviewStep {...props} /> : null}
    </div>
  );
}

function ReviewStep({ work, issues, makeDefault, setMakeDefault, newWorkflow, changeNote, setChangeNote, publishable, dirty, onJump }: StepBodyProps) {
  const { definition } = work;
  return (
    <>
      <IssueList issues={issues} title={errorsOf(issues).length ? "Fix these problems before publishing" : "Warnings (publishing is still allowed)"} onJump={onJump} />
      {publishable ? <Callout tone="success">The draft has no problems and is ready to publish.</Callout> : null}
      {dirty ? <Callout tone="info">You have unsaved changes. Publishing saves them first.</Callout> : null}
      <DefinitionTables definition={definition} />
      <RulesReviewSummary definition={definition} />
      <Checkbox label="Use for new orders (default workflow)" description="If you leave this off, new orders keep using the current default." checked={makeDefault} onCheckedChange={setMakeDefault} />
      {/* Increment 07.2: say where the default lives, so it can be found later. */}
      <p className="text-sm text-body">
        {newWorkflow
          ? "A draft must be published before it can be the default. Tick the box above to make this new workflow the default when you publish it, or publish now and choose it later."
          : "A draft must be published before it can be the default."}{" "}
        You can change the default workflow any time with “Set as default” on the Workflows list.
      </p>
      <Field label="Change note (optional)" hint="Shown in the version list, for example why the change was made.">
        <Textarea value={changeNote} maxLength={500} rows={3} onChange={(event) => setChangeNote(event.target.value)} />
      </Field>
    </>
  );
}

export function DefinitionTables({ definition, caption = "" }: { definition: { states: DraftState[] | readonly DraftState[]; transitions: readonly (Omit<DraftTransition, "actionLabel"> & { actionLabel?: string | undefined })[] }; caption?: string }) {
  const label = (key: string) => definition.states.find((state) => state.key === key)?.label || key;
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <DataTable
        caption={`Statuses${caption}`}
        showCaption
        rows={[...definition.states]}
        rowKey={(state) => `${state.key}-${definition.states.indexOf(state)}`}
        columns={[
          { key: "label", header: "Status", primary: true, cell: (state) => <OrderStatusBadge label={state.label || "(no label)"} tone={state.tone} /> },
          { key: "customer", header: "Customers see", cell: (state) => state.customerLabel },
          { key: "kind", header: "Stage", cell: (state) => KIND_LABEL[state.kind] ?? state.kind },
          { key: "key", header: "Key", hideOnMobile: true, cell: (state) => <code className="font-mono text-sm">{state.key}</code> },
        ]}
      />
      <DataTable
        caption={`Transitions${caption}`}
        showCaption
        rows={[...definition.transitions]}
        rowKey={(t) => `${t.from}-${t.to}-${definition.transitions.indexOf(t)}`}
        empty="No transitions."
        columns={[
          { key: "move", header: "Move", primary: true, cell: (t) => `${label(t.from)} to ${label(t.to)}` },
          { key: "who", header: "Who may move", cell: (t) => t.allowedBy.map((actor) => ACTOR_LABEL[actor] ?? actor).join(", ") || "Nobody" },
          { key: "notify", header: "Customer notified", cell: (t) => (t.notifyCustomer ? "Yes" : "No") },
          { key: "note", header: "Note required", hideOnMobile: true, cell: (t) => (t.requiresNote ? "Yes" : "No") },
        ]}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ canvas */

export function toCanvas(definition: { states: readonly DraftState[]; transitions: readonly { from: string; to: string }[] }, layout: Layout) {
  const indexByKey = new Map<string, number>();
  definition.states.forEach((state, index) => {
    if (state.key && !indexByKey.has(state.key)) indexByKey.set(state.key, index);
  });
  const nodes = definition.states.map((state, index) => ({
    id: nodeId(index),
    label: state.label.trim() || state.key || `Status ${index + 1}`,
    sublabel: state.customerLabel && state.customerLabel !== state.label ? `Customers see: ${state.customerLabel}` : undefined,
    kind: KIND_LABEL[state.kind] ?? "Status",
    tone: state.tone,
    ...positionOf(layout, state.key, index),
  }));
  const edges = definition.transitions.flatMap((transition, index) => {
    const from = indexByKey.get(transition.from);
    const to = indexByKey.get(transition.to);
    return from === undefined || to === undefined ? [] : [{ id: edgeId(index), from: nodeId(from), to: nodeId(to), label: `Transition ${index + 1}` }];
  });
  return { nodes, edges };
}

function CanvasView({ work, issues, edit, setDefinition }: { work: Editable; issues: WorkflowIssue[]; edit: StepBodyProps["edit"]; setDefinition: (definition: DraftDefinition) => void }) {
  const { definition, layout } = work;
  const [selected, setSelected] = useState<FlowSelection>(null);
  const [connect, setConnect] = useState({ from: "", to: "" });
  const graph = useMemo(() => toCanvas(definition, layout), [definition, layout]);
  const keyOf = (id: string) => definition.states[indexOfId(id)]?.key ?? "";

  const addTransition = (from: string, to: string) => {
    if (!from || !to) return;
    setDefinition({ ...definition, transitions: [...definition.transitions, newTransition(from, to)] });
    setSelected({ type: "edge", id: edgeId(definition.transitions.length) });
  };
  const remove = (selection: NonNullable<FlowSelection>) => {
    const index = indexOfId(selection.id);
    if (selection.type === "node") edit((current) => ({ ...current, ...removeState(current.definition, current.layout, index) }));
    else setDefinition(removeTransition(definition, index));
    setSelected(null);
  };

  const selectedState = selected?.type === "node" ? definition.states[indexOfId(selected.id)] : undefined;
  const selectedTransition = selected?.type === "edge" ? definition.transitions[indexOfId(selected.id)] : undefined;
  const stateOptions = definition.states.filter((state) => state.key.trim()).map((state) => ({ value: state.key, label: state.label.trim() || state.key }));
  const unplaced = definition.transitions.length - graph.edges.length;

  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex min-w-0 flex-col gap-3">
        <FlowCanvas
          label="Workflow canvas"
          height="lg"
          nodes={graph.nodes}
          edges={graph.edges}
          selected={selected}
          onSelect={setSelected}
          onMove={(id, x, y) => {
            const key = keyOf(id);
            if (key) edit((current) => ({ ...current, layout: setPosition(current.layout, key, x, y) }));
          }}
          onArrange={(positions) =>
            edit((current) => ({
              ...current,
              layout: Object.entries(positions).reduce((next, [id, at]) => {
                const key = current.definition.states[indexOfId(id)]?.key ?? "";
                return key ? setPosition(next, key, at.x, at.y) : next;
              }, current.layout),
            }))
          }
          onConnect={(from, to) => addTransition(keyOf(from), keyOf(to))}
          onDelete={remove}
        />
        {unplaced > 0 ? <Callout tone="warning">{`${unplaced} transition(s) point to a status that does not exist and are not drawn. Fix them in the Transitions step.`}</Callout> : null}
        <IssueList issues={issues} title="Problems found when the draft was last saved" />
      </div>
      <aside aria-label="Properties" className="flex min-w-0 flex-col gap-4">
        {selectedState && selected ? (
          <Card title={`Status: ${selectedState.label || "(no label)"}`} headingLevel={2}>
            <div className="flex flex-col gap-4">
              <StatusFields state={selectedState} index={indexOfId(selected.id)} issues={issues} onChange={(patch) => edit((current) => ({ ...current, ...updateState(current.definition, current.layout, indexOfId(selected.id), patch) }))} />
              <StateRulesFields definition={definition} state={selectedState} index={indexOfId(selected.id)} issues={issues} onChange={(patch) => edit((current) => ({ ...current, ...updateState(current.definition, current.layout, indexOfId(selected.id), patch) }))} />
              <Button variant="danger" size="sm" onClick={() => remove(selected)}>
                Remove status
              </Button>
            </div>
          </Card>
        ) : null}
        {selectedTransition && selected ? (
          <Card title={`Transition: ${stateLabel(definition, selectedTransition.from)} to ${stateLabel(definition, selectedTransition.to)}`} headingLevel={2}>
            <div className="flex flex-col gap-4">
              {(() => {
                const index = indexOfId(selected.id);
                const change = (patch: Partial<DraftTransition>) => setDefinition(updateTransition(definition, index, patch));
                const common = { definition, transition: selectedTransition, index, issues, onChange: change };
                return (
                  <>
                    <TransitionRouteFields {...common} />
                    <TransitionWhoFields {...common} />
                    <TransitionNoticeFields {...common} />
                  </>
                );
              })()}
              <Button variant="danger" size="sm" onClick={() => remove(selected)}>
                Remove transition
              </Button>
            </div>
          </Card>
        ) : null}
        {!selectedState && !selectedTransition ? (
          <Card title="Properties" headingLevel={2}>
            <p className="text-body">Select a status or a transition on the canvas to edit it here. You can also use the forms below instead of dragging.</p>
          </Card>
        ) : null}
        {definition.stages?.length ? null : (
          <Card title="Status groups (older workflows)" headingLevel={2}>
            <PhasesEditor definition={definition} issues={issues} onChange={setDefinition} />
          </Card>
        )}
        <Card title="Acceptance and storage" headingLevel={2}>
          <div className="flex flex-col gap-4">
            <AcceptanceGatesEditor definition={definition} issues={issues} onChange={setDefinition} />
            <StorageFolderEditor definition={definition} issues={issues} onChange={setDefinition} />
          </div>
        </Card>
        <Card title="Add" headingLevel={2}>
          <div className="flex flex-col gap-4">
            <Button
              variant="secondary"
              disabled={definition.states.length >= 30}
              onClick={() => {
                const added = addState(definition, layout);
                edit((current) => ({ ...current, definition: added.definition, layout: added.layout }));
                setSelected({ type: "node", id: nodeId(added.index) });
              }}
            >
              <Plus aria-hidden="true" className="size-4" />
              Add status
            </Button>
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-1 text-sm font-medium text-ink">Add a transition</legend>
              <Field label="From">
                <Select value={connect.from} placeholder="Choose a status" options={stateOptions} onChange={(event) => setConnect((c) => ({ ...c, from: event.target.value }))} />
              </Field>
              <Field label="To">
                <Select value={connect.to} placeholder="Choose a status" options={stateOptions} onChange={(event) => setConnect((c) => ({ ...c, to: event.target.value }))} />
              </Field>
              <Button
                variant="secondary"
                disabled={!connect.from || !connect.to || definition.transitions.length >= 200}
                onClick={() => {
                  addTransition(connect.from, connect.to);
                  setConnect({ from: "", to: "" });
                }}
              >
                Add transition
              </Button>
            </fieldset>
          </div>
        </Card>
      </aside>
    </div>
  );
}
