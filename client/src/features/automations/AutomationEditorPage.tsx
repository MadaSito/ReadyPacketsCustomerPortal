/**
 * /admin/automations/new and /admin/automations/:automationId/edit — one draft, two builders: a step-by-step
 * wizard (trigger → conditions → actions → review) and a canvas. Owner: audit engineer.
 * The canvas has button alternatives for everything drag does (add, move earlier/later, remove).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useLocation, useParams, useSearch } from "wouter";
import { errorMessage } from "@/lib/trpc";
import {
  Breadcrumbs, Button, Callout, Card, ErrorState, FlowCanvas, PageHeader, Skeleton, StepUpCancelledError, Tabs, Wizard, useStepUp, useToast,
  type FlowSelection,
} from "@/ui";
import { useAutomationsApi } from "./api";
import {
  BASE, CONDITIONS_NODE, TRIGGER_NODE, addGroup, connect, draftFromDetail, draftFromRecipe, emptyDraft, hasErrors, moveAction, removeAction, setPosition,
  toGraph, toSaveInput, validateDraft, type AutomationTestRunResult, type Catalogue, type Draft, type StepId,
} from "./model";
import { ActionForm, ActionsEditor, AddActionPicker, ConditionsEditor, DraftSummary, TestRunResultView, TriggerEditor } from "./parts";

const STEPS: { id: StepId; label: string }[] = [
  { id: "trigger", label: "Trigger" },
  { id: "conditions", label: "Conditions" },
  { id: "actions", label: "Actions" },
  { id: "review", label: "Review" },
];

export default function AutomationEditorPage() {
  const { automationId } = useParams<{ automationId?: string }>();
  const search = useSearch();
  const api = useAutomationsApi();
  const catalogue = useQuery(api.catalogue.queryOptions());
  const detail = useQuery({ ...api.get.queryOptions({ publicId: automationId ?? "" }), enabled: Boolean(automationId) });
  const recipeKey = new URLSearchParams(search).get("recipe");

  const title = automationId ? "Edit automation" : "New automation";
  const header = (
    <PageHeader
      breadcrumbs={<Breadcrumbs items={[{ label: "Console", href: "/admin" }, { label: "Automations", href: BASE }, ...(automationId && detail.data ? [{ label: detail.data.name, href: `${BASE}/${automationId}` }] : []), { label: title }]} />}
      title={title}
      description="Build it step by step, or switch to the canvas. Both edit the same automation."
    />
  );
  if (catalogue.isPending || (automationId && detail.isPending)) return <>{header}<Skeleton lines={6} /></>;
  if (catalogue.error) return <>{header}<ErrorState error={catalogue.error} onRetry={() => catalogue.refetch()} /></>;
  if (automationId && detail.error) return <>{header}<ErrorState error={detail.error} onRetry={() => detail.refetch()} /></>;
  const cat = catalogue.data!;
  const recipe = recipeKey ? cat.starterRecipes.find((r) => r.key === recipeKey) : undefined;
  const initial = detail.data ? draftFromDetail(detail.data, cat) : recipe ? draftFromRecipe(recipe, cat) : emptyDraft();
  return (
    <>
      {header}
      {recipeKey && !recipe && !automationId ? <Callout tone="warning" title="Recipe not found" className="mb-4">Starting from a blank automation instead.</Callout> : null}
      <Editor key={detail.data ? `${detail.data.publicId}:${detail.data.version}` : recipe?.key ?? "blank"} catalogue={cat} initial={initial}
        publicId={automationId} expectedVersion={detail.data?.version} />
    </>
  );
}

export function Editor({ catalogue, initial, publicId, expectedVersion }: { catalogue: Catalogue; initial: Draft; publicId?: string; expectedVersion?: number }) {
  const api = useAutomationsApi();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const toast = useToast();
  const [, navigate] = useLocation();
  const [draft, setDraft] = useState<Draft>(initial);
  const [mode, setMode] = useState("wizard");
  const [step, setStep] = useState<StepId>("trigger");
  const [shown, setShown] = useState<Set<StepId>>(new Set());
  const [test, setTest] = useState<AutomationTestRunResult | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const create = useMutation(api.create.mutationOptions());
  const update = useMutation(api.update.mutationOptions());
  const testRun = useMutation(api.testRun.mutationOptions());

  const errors = useMemo(() => validateDraft(draft, catalogue), [draft, catalogue]);
  const visible = (id: Exclude<StepId, "review">) => (shown.has(id) ? errors[id] : {});
  const index = STEPS.findIndex((s) => s.id === step);
  const allValid = !hasErrors(errors.trigger) && !hasErrors(errors.conditions) && !hasErrors(errors.actions);
  const change = (next: Draft) => { setDraft(next); setTest(null); setSaveError(null); };

  const next = () => {
    if (step === "review") { void save(); return; }
    const id = step as Exclude<StepId, "review">;
    setShown((s) => new Set(s).add(id));
    if (hasErrors(errors[id])) return;
    setStep(STEPS[index + 1]!.id);
  };

  const save = async () => {
    setShown(new Set(["trigger", "conditions", "actions"]));
    if (!allValid) { setSaveError("Fix the highlighted steps before saving."); return; }
    const input = toSaveInput(draft, catalogue);
    try {
      const saved = await stepUp.run(
        () => (publicId && expectedVersion !== undefined ? update.mutateAsync({ ...input, publicId, expectedVersion }) : create.mutateAsync(input)),
        { reason: "Saving an automation requires a fresh confirmation." },
      );
      toast.show({ title: publicId ? "Automation saved" : "Automation created", description: saved.enabled ? undefined : "It is turned off. Turn it on from its page when you are ready.", tone: "success" });
      await qc.invalidateQueries(api.list.pathFilter());
      await qc.invalidateQueries(api.get.pathFilter());
      navigate(`${BASE}/${saved.publicId}`);
    } catch (error) {
      if (error instanceof StepUpCancelledError) return;
      setSaveError(errorMessage(error, "The automation was not saved."));
    }
  };

  const runTest = async () => {
    setShown(new Set(["trigger", "conditions", "actions"]));
    if (!allValid) { setSaveError("Fix the highlighted steps before testing."); return; }
    const { name: _n, description: _d, maxRunsPerHour: _m, canvasLayout: _c, ...rest } = toSaveInput(draft, catalogue);
    try {
      const result = await stepUp.run(() => testRun.mutateAsync({ ...rest, ...(publicId ? { publicId } : {}), executeLive: false }), { reason: "A test run requires a fresh confirmation." });
      setTest(result);
    } catch (error) {
      if (error instanceof StepUpCancelledError) return;
      setSaveError(errorMessage(error, "The test could not run."));
    }
  };

  const busy = create.isPending || update.isPending;
  const footer = (
    <div className="flex flex-col gap-3">
      {saveError ? <Callout tone="danger" title="Not saved">{saveError}</Callout> : null}
      {test ? <TestRunResultView result={test} /> : null}
    </div>
  );

  const wizard = (
    <div className="flex flex-col gap-4">
      <Wizard
        steps={STEPS}
        current={step}
        completed={STEPS.slice(0, index).map((s) => s.id)}
        onStepSelect={(id) => setStep(id as StepId)}
        onBack={() => setStep(STEPS[Math.max(0, index - 1)]!.id)}
        onNext={next}
        nextLabel={step === "review" ? "Save" : "Continue"}
        busy={busy}
        secondaryAction={step === "review" ? <Button variant="secondary" onClick={() => void runTest()} loading={testRun.isPending}>Test without sending</Button> : undefined}
      >
        {step === "trigger" ? <TriggerEditor draft={draft} onChange={change} catalogue={catalogue} errors={visible("trigger")} /> : null}
        {step === "conditions" ? <ConditionsEditor draft={draft} onChange={change} catalogue={catalogue} errors={visible("conditions")} /> : null}
        {step === "actions" ? <ActionsEditor draft={draft} onChange={change} catalogue={catalogue} errors={visible("actions")} /> : null}
        {step === "review" ? (
          <div className="flex flex-col gap-4">
            {!allValid ? <Callout tone="danger" title="Some steps need attention">{(["trigger", "conditions", "actions"] as const).filter((id) => hasErrors(errors[id])).map((id) => STEPS.find((s) => s.id === id)!.label).join(", ")}.</Callout> : null}
            <DraftSummary draft={draft} catalogue={catalogue} />
          </div>
        ) : null}
      </Wizard>
      {footer}
    </div>
  );

  return (
    <Tabs label="Builder" value={mode} onValueChange={setMode} items={[
      { value: "wizard", label: "Step by step", content: wizard },
      { value: "canvas", label: "Canvas", content: (
        <div className="flex flex-col gap-4">
          <CanvasBuilder draft={draft} onChange={change} catalogue={catalogue} errors={errors} />
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void save()} loading={busy}>Save</Button>
            <Button variant="secondary" onClick={() => void runTest()} loading={testRun.isPending}>Test without sending</Button>
            <Button asChild variant="ghost"><Link href={publicId ? `${BASE}/${publicId}` : BASE}>Cancel</Link></Button>
          </div>
          {footer}
        </div>
      ) },
    ]} />
  );
}

export function CanvasBuilder({ draft, onChange, catalogue, errors }: { draft: Draft; onChange: (d: Draft) => void; catalogue: Catalogue; errors: ReturnType<typeof validateDraft> }) {
  const [selected, setSelected] = useState<FlowSelection>({ type: "node", id: TRIGGER_NODE });
  const graph = toGraph(draft, catalogue, errors);
  const selId = selected?.type === "node" ? selected.id : null;
  const actionIndex = draft.actions.findIndex((a) => a.stepKey === selId);
  const action = actionIndex >= 0 ? draft.actions[actionIndex] : undefined;
  const remove = (id: string) => {
    if (id === CONDITIONS_NODE) onChange({ ...draft, groups: [] });
    else if (draft.actions.some((a) => a.stepKey === id)) onChange(removeAction(draft, id));
    setSelected({ type: "node", id: TRIGGER_NODE });
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]">
      <div className="flex min-w-0 flex-col gap-2">
        <FlowCanvas label="Automation canvas" nodes={graph.nodes} edges={graph.edges} height="md" selected={selected} onSelect={setSelected}
          onMove={(id, x, y) => onChange(setPosition(draft, id, x, y))}
          onArrange={(positions) => onChange({ ...draft, positions: { ...draft.positions, ...positions } })}
          onConnect={(from, to) => { const next = connect(draft, from, to); if (next) onChange(next); }}
          onDelete={(sel) => { if (sel.type === "node") remove(sel.id); }} />
        <p className="text-sm text-muted">Select a box to edit it. Connecting a box to an action moves that action right after it. Every change can also be made with the buttons beside the canvas.</p>
      </div>
      <Card as="section" headingLevel={2} title={selId === TRIGGER_NODE ? "Trigger" : selId === CONDITIONS_NODE ? "Conditions" : action ? `Step ${actionIndex + 1}` : "Edit"}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => { onChange(draft.groups.length ? draft : addGroup(draft)); setSelected({ type: "node", id: CONDITIONS_NODE }); }}>
              {draft.groups.length ? "Edit conditions" : "Add condition"}
            </Button>
            {action ? <>
              <Button size="sm" variant="ghost" disabled={actionIndex === 0} onClick={() => onChange(moveAction(draft, action.stepKey, -1))}>Move earlier</Button>
              <Button size="sm" variant="ghost" disabled={actionIndex === draft.actions.length - 1} onClick={() => onChange(moveAction(draft, action.stepKey, 1))}>Move later</Button>
            </> : null}
            {action || selId === CONDITIONS_NODE ? <Button size="sm" variant="ghost" onClick={() => remove(selId!)}>Remove</Button> : null}
          </div>
          {selId === TRIGGER_NODE ? <TriggerEditor draft={draft} onChange={onChange} catalogue={catalogue} errors={errors.trigger} /> : null}
          {selId === CONDITIONS_NODE ? <ConditionsEditor draft={draft} onChange={onChange} catalogue={catalogue} errors={errors.conditions} /> : null}
          {action ? <ActionForm step={action} index={actionIndex} draft={draft} onChange={onChange} catalogue={catalogue} errors={errors.actions} /> : null}
          <AddActionPicker draft={draft} catalogue={catalogue} afterIndex={action ? actionIndex : undefined}
            onChange={(next) => { onChange(next); const added = next.actions.find((a) => !draft.actions.some((b) => b.stepKey === a.stepKey)); if (added) setSelected({ type: "node", id: added.stepKey }); }} />
        </div>
      </Card>
    </div>
  );
}
