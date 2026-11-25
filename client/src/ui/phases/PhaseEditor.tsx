/**
 * "Edit order workflow" phase editor (increment 07 package A, D1). Two designer views over one shared phase
 * form: the visual phase canvas (ordered cards; drag to reorder, or the Up / Down buttons, which are the
 * keyboard and screen-reader path) and the guided designer (one phase per step). Controlled and display-only:
 * the host (orders' WorkflowDesignerPage) owns loading, saving, step-up and server validation.
 */
import { ArrowDown, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, GripVertical, Lock, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from "react";
import { MAX_STAGES, type WorkflowStage } from "@shared/workflowStages";
import { Badge } from "../Badge";
import { Button, IconButton } from "../Button";
import { Callout } from "../Feedback";
import { Field, Select } from "../Field";
import { ConfirmDialog } from "../Overlay";
import { cn } from "../cn";
import { canAddStage, configuredActionCount, enabledCustomerActions, move, newStage, removeAt, stageErrors, type PhaseStatusOption } from "./model";
import { PhaseForm, type PhaseSlotRenderer } from "./PhaseForm";

export type PhaseDesignerView = "canvas" | "guided";

export interface PhaseEditorProps {
  value: readonly WorkflowStage[];
  onChange: (next: WorkflowStage[]) => void;
  /** Status catalogue (orders.statusCatalog.list), in catalogue order. */
  statusOptions: readonly PhaseStatusOption[];
  /** Server issues by full path ("stages.2.customerLabel", "stages.2.statusKeys.0", "stages"). */
  errors?: Readonly<Record<string, string>>;
  disabled?: boolean;
  /** Phase keys of the published version: renaming one shows a warning (its files and questions lose their phase). */
  publishedKeys?: ReadonlySet<string>;
  /** Feature-owned regions; normally `PHASE_FORM_SLOTS` from `@/app/slots`. */
  slots?: PhaseSlotRenderer;
  view?: PhaseDesignerView;
  defaultView?: PhaseDesignerView;
  onViewChange?: (view: PhaseDesignerView) => void;
  /** Level of the editor's own heading ("Phases"); cards use the next level. */
  headingLevel?: 2 | 3;
}

let idCounter = 0;
const nextId = () => `phase${(idCounter += 1).toString(36)}`;

/** Card ids parallel to `value`. If the host replaces the list with a different length, missing ids are filled deterministically. */
function alignIds(ids: readonly string[], length: number): string[] {
  if (ids.length === length) return [...ids];
  if (ids.length > length) return ids.slice(0, length);
  return [...ids, ...Array.from({ length: length - ids.length }, (_, n) => `fill${ids.length + n}`)];
}

function summary(stage: WorkflowStage): string[] {
  const parts = [`${stage.statusKeys.length} ${stage.statusKeys.length === 1 ? "status" : "statuses"}`];
  const actions = enabledCustomerActions(stage);
  parts.push(actions ? `${actions} customer ${actions === 1 ? "action" : "actions"}` : "No customer actions");
  if (stage.progression === "submit_lock") parts.push("Submit and lock");
  const runs = configuredActionCount(stage.stageActions);
  if (runs) parts.push(`${runs} phase ${runs === 1 ? "action" : "actions"}`);
  if (stage.completesOn === "payment") parts.push("Completes on payment");
  return parts;
}

export function PhaseEditor({
  value, onChange, statusOptions, errors = {}, disabled = false, publishedKeys, slots, view: controlledView, defaultView = "canvas", onViewChange, headingLevel = 2,
}: PhaseEditorProps) {
  const uid = useId().replace(/:/g, "");
  const [ownIds, setIds] = useState<string[]>(() => value.map(() => nextId()));
  const ids = alignIds(ownIds, value.length);
  const [originalKeys] = useState<ReadonlyMap<string, string>>(() => new Map(ownIds.map((cardId, index) => [cardId, value[index]?.key ?? ""])));
  const [armedId, setArmedId] = useState<string | null>(null);
  const [ownView, setOwnView] = useState<PhaseDesignerView>(defaultView);
  const view = controlledView ?? ownView;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(ownIds.slice(0, value.length <= 3 ? value.length : 1)));
  const [guided, setGuided] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [pendingRemove, setPendingRemove] = useState<number | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const H = `h${headingLevel}` as const;
  const cardLevel = (headingLevel + 1) as 3 | 4;
  const formLevel = (cardLevel + 1) as 4 | 5;
  const workflowStatusKeys = value.flatMap((stage) => stage.statusKeys);
  const guidedIndex = Math.min(guided, Math.max(0, value.length - 1));

  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    document.getElementById(target)?.focus();
  });

  const setView = (next: PhaseDesignerView) => { setOwnView(next); onViewChange?.(next); };
  const label = (stage: WorkflowStage | undefined, index: number) => stage?.staffLabel.trim() || stage?.customerLabel.trim() || `Phase ${index + 1}`;
  const takenFor = (index: number) => {
    const map = new Map<string, string>();
    value.forEach((stage, position) => { if (position !== index) stage.statusKeys.forEach((key) => map.set(key, label(stage, position))); });
    return map;
  };
  const keyWarning = (index: number) => {
    const cardId = ids[index]!;
    const original = originalKeys.get(cardId);
    const stage = value[index]!;
    return publishedKeys && original && publishedKeys.has(original) && stage.key !== original
      ? `The published version uses the key ${original}. Orders already on that version keep it. In the new version, this phase gets a new identity: reports and integrations that use the old key stop matching it.`
      : undefined;
  };

  function update(index: number, next: WorkflowStage) {
    onChange(value.map((stage, position) => (position === index ? next : stage)));
  }
  function moveCard(from: number, to: number, via: "up" | "down" | "drag") {
    if (to < 0 || to >= value.length || from === to) return;
    const moved = move(ids, from, to);
    setIds(moved);
    onChange(move(value, from, to));
    setAnnouncement(`${label(value[from], from)} moved to position ${to + 1} of ${value.length}.`);
    if (via !== "drag") {
      const cardId = moved[to]!;
      const edge = (via === "up" && to === 0) || (via === "down" && to === value.length - 1);
      pendingFocus.current = `${uid}-${cardId}-${edge ? (via === "up" ? "down" : "up") : via}`;
    }
  }
  function add(after: number) {
    if (!canAddStage(value)) return;
    const unused = statusOptions.find((option) => !option.retired && !workflowStatusKeys.includes(option.key));
    const stage = newStage(value, unused?.key);
    const at = after + 1;
    const cardId = nextId();
    setIds([...ids.slice(0, at), cardId, ...ids.slice(at)]);
    const next = [...value.slice(0, at), stage, ...value.slice(at)];
    onChange(next);
    setExpanded((prior) => new Set([...prior, cardId]));
    setGuided(at);
    setAnnouncement(`${stage.customerLabel} added at position ${at + 1} of ${next.length}.`);
    pendingFocus.current = view === "canvas" ? `${uid}-${cardId}-toggle` : `${uid}-guided-heading`;
  }
  function remove(index: number) {
    const removed = value[index];
    const remaining = removeAt(ids, index);
    setIds(remaining);
    onChange(removeAt(value, index));
    setAnnouncement(`${label(removed, index)} removed.`);
    const focusIndex = Math.min(index, value.length - 2);
    pendingFocus.current = focusIndex >= 0 ? (view === "canvas" ? `${uid}-${remaining[focusIndex]}-toggle` : `${uid}-guided-heading`) : `${uid}-add`;
    if (view === "guided") setGuided(Math.max(0, focusIndex));
  }

  // Pointer drag (mouse / pen) from the grip only; keyboard and touch users use Up / Down.
  const dragProps = (index: number, cardId: string) => ({
    draggable: !disabled && armedId === cardId,
    onDragStart: (event: DragEvent<HTMLLIElement>) => {
      if (armedId !== cardId) { event.preventDefault(); return; }
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", cardId);
      setDragFrom(index);
    },
    onDragOver: (event: DragEvent<HTMLLIElement>) => { if (dragFrom === null) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; if (dragOver !== index) setDragOver(index); },
    onDrop: (event: DragEvent<HTMLLIElement>) => { event.preventDefault(); if (dragFrom !== null) moveCard(dragFrom, index, "drag"); setDragFrom(null); setDragOver(null); setArmedId(null); },
    onDragEnd: () => { setDragFrom(null); setDragOver(null); setArmedId(null); },
  });

  const listError = errors.stages;
  const removeTarget = pendingRemove !== null ? value[pendingRemove] : undefined;

  return (
    <section aria-labelledby={`${uid}-title`} className="@container grid min-w-0 gap-4">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <H id={`${uid}-title`} className="text-lg font-semibold text-ink">Phases</H>
          <p className="max-w-[70ch] text-sm text-body">Phases are what the customer sees: each one has its own instructions, actions and progress. Keys are stable references; rename the labels freely.</p>
        </div>
        <div className="flex min-w-0 flex-wrap items-end gap-3">
          <Field id={`${uid}-view`} label="Designer" className="w-full min-w-0 @md:w-56">
            <Select value={view} onChange={(event) => setView(event.currentTarget.value as PhaseDesignerView)}
              options={[{ value: "canvas", label: "Visual phase canvas" }, { value: "guided", label: "Guided designer" }]} />
          </Field>
          <Button id={`${uid}-add`} variant="secondary" leadingIcon={<Plus aria-hidden="true" />} disabled={disabled || !canAddStage(value)}
            onClick={() => add(view === "guided" ? guidedIndex : value.length - 1)}>
            Add phase
          </Button>
        </div>
      </div>
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
      {listError ? <Callout tone="danger" title="Phases need attention" live="polite">{listError}</Callout> : null}
      {!canAddStage(value) ? <p className="text-sm text-muted">A workflow can have up to {MAX_STAGES} phases.</p> : null}
      {value.length === 0 ? (
        <div className="rounded-[var(--radius-card)] border border-dashed border-line p-6 text-center text-sm text-muted">No phases yet. Add the first phase the customer will see.</div>
      ) : view === "canvas" ? (
        <ol aria-label="Phases in order" className="grid min-w-0 gap-3">
          {value.map((stage, index) => {
            const cardId = ids[index]!;
            const open = expanded.has(cardId);
            const cardErrors = stageErrors(errors, index);
            const errorCount = Object.keys(cardErrors).length;
            const name = label(stage, index);
            const bodyId = `${uid}-${cardId}-body`;
            return (
              <li key={cardId} {...dragProps(index, cardId)}
                className={cn(
                  "rp-phase-card min-w-0 rounded-[var(--radius-card)] border bg-surface shadow-sm rp-forced-border",
                  errorCount ? "border-danger" : "border-line",
                  dragFrom === index && "opacity-60",
                  dragOver === index && dragFrom !== null && dragFrom !== index && "ring-2 ring-action",
                )}>
                <div className="flex min-w-0 items-start gap-2 p-3 @md:gap-3 @md:p-4">
                  <div className="flex shrink-0 flex-col items-center gap-1 pt-1">
                    <span aria-hidden="true" title="Drag to reorder" className={cn("hidden cursor-grab touch-none text-muted @md:inline-flex", disabled && "cursor-not-allowed opacity-50")}
                      onPointerDown={() => setArmedId(cardId)} onPointerUp={() => { if (dragFrom === null) setArmedId(null); }}>
                      <GripVertical className="size-5" />
                    </span>
                    <span aria-hidden="true" className="flex size-7 items-center justify-center rounded-full bg-action text-xs font-semibold text-on-action">{index + 1}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    {(() => { const CardH = `h${cardLevel}` as const; return (
                      <CardH className="min-w-0">
                        <button id={`${uid}-${cardId}-toggle`} type="button" aria-expanded={open} aria-controls={bodyId}
                          onClick={() => setExpanded((prior) => { const next = new Set(prior); if (next.has(cardId)) next.delete(cardId); else next.add(cardId); return next; })}
                          className="flex min-h-11 w-full min-w-0 items-start gap-2 rounded-[var(--radius-control)] text-left">
                          <ChevronDown aria-hidden="true" className={cn("mt-1 size-4 shrink-0 text-muted transition-transform", !open && "-rotate-90")} />
                          <span className="flex min-w-0 flex-col">
                            <span className="text-base font-semibold break-words text-ink [overflow-wrap:anywhere]"><span className="sr-only">Phase {index + 1} of {value.length}: </span>{name}</span>
                            <span className="font-mono text-xs break-all text-muted">{stage.key || "no key"}</span>
                          </span>
                        </button>
                      </CardH>
                    ); })()}
                    <ul aria-label={`Summary of ${name}`} className="mt-1 flex min-w-0 flex-wrap gap-1.5 pl-6">
                      {summary(stage).map((part) => <li key={part}><Badge tone="neutral">{part === "Submit and lock" ? <Lock aria-hidden="true" className="mr-1 inline size-3" /> : null}{part}</Badge></li>)}
                      {errorCount ? <li><Badge tone="danger">{errorCount} {errorCount === 1 ? "problem" : "problems"}</Badge></li> : null}
                    </ul>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1 @md:flex-row">
                    <IconButton id={`${uid}-${cardId}-up`} size="sm" label={`Move ${name} up`} icon={<ArrowUp aria-hidden="true" />} disabled={disabled || index === 0} onClick={() => moveCard(index, index - 1, "up")} />
                    <IconButton id={`${uid}-${cardId}-down`} size="sm" label={`Move ${name} down`} icon={<ArrowDown aria-hidden="true" />} disabled={disabled || index === value.length - 1} onClick={() => moveCard(index, index + 1, "down")} />
                    <IconButton size="sm" label={`Remove ${name}`} icon={<Trash2 aria-hidden="true" className="text-danger" />} disabled={disabled || value.length <= 1} onClick={() => setPendingRemove(index)} />
                  </div>
                </div>
                <div id={bodyId} hidden={!open} className="@container min-w-0 border-t border-line p-3 @md:p-4">
                  {open ? (
                    <PhaseForm stage={stage} index={index} onChange={(next) => update(index, next)} statusOptions={statusOptions} takenStatuses={takenFor(index)}
                      workflowStatusKeys={workflowStatusKeys} errors={cardErrors} disabled={disabled} headingLevel={formLevel} keyWarning={keyWarning(index)} slots={slots} idPrefix={`${uid}-${cardId}`} />
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <Guided
          uid={uid}
          stages={value}
          index={guidedIndex}
          onIndex={(next) => { setGuided(next); pendingFocus.current = `${uid}-guided-heading`; }}
          label={label}
          errors={errors}
          headingLevel={cardLevel}
        >
          <PhaseForm key={ids[guidedIndex]} stage={value[guidedIndex]!} index={guidedIndex} onChange={(next) => update(guidedIndex, next)} statusOptions={statusOptions}
            takenStatuses={takenFor(guidedIndex)} workflowStatusKeys={workflowStatusKeys} errors={stageErrors(errors, guidedIndex)} disabled={disabled}
            headingLevel={formLevel} keyWarning={keyWarning(guidedIndex)} slots={slots} idPrefix={`${uid}-g-${ids[guidedIndex]}`} />
        </Guided>
      )}
      <ConfirmDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => { if (!open) setPendingRemove(null); }}
        title={removeTarget ? `Remove ${label(removeTarget, pendingRemove ?? 0)}?` : "Remove phase?"}
        description="The phase is removed from this draft only. Published versions and existing orders are not changed."
        confirmLabel="Remove phase"
        destructive
        onConfirm={() => { if (pendingRemove !== null) remove(pendingRemove); setPendingRemove(null); }}
      />
    </section>
  );
}

function Guided({ uid, stages, index, onIndex, label, errors, headingLevel, children }: {
  uid: string; stages: readonly WorkflowStage[]; index: number; onIndex: (index: number) => void;
  label: (stage: WorkflowStage | undefined, index: number) => string; errors: Readonly<Record<string, string>>; headingLevel: 3 | 4; children: ReactNode;
}) {
  const H = `h${headingLevel}` as const;
  const stage = stages[index];
  return (
    <div className="grid min-w-0 gap-4 @4xl:grid-cols-[15rem_minmax(0,1fr)]">
      <nav aria-label="Phases" className="min-w-0">
        <ol className="flex min-w-0 gap-2 overflow-x-auto pb-1 @4xl:flex-col @4xl:overflow-visible">
          {stages.map((item, position) => {
            const problems = Object.keys(stageErrors(errors, position)).length;
            return (
              <li key={`${item.key}-${position}`} className="shrink-0 @4xl:shrink">
                <button type="button" aria-current={position === index ? "step" : undefined} onClick={() => onIndex(position)}
                  className={cn(
                    "flex min-h-11 w-full min-w-0 items-center gap-2 rounded-[var(--radius-control)] border px-3 py-2 text-left text-sm",
                    position === index ? "border-action bg-action-soft font-semibold text-ink" : "border-line bg-surface text-body hover:bg-surface-soft",
                  )}>
                  <span aria-hidden="true" className={cn("flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold", position === index ? "bg-action text-on-action" : "bg-surface-sunken text-muted")}>{position + 1}</span>
                  <span className="min-w-0 break-words [overflow-wrap:anywhere]">{label(item, position)}</span>
                  {problems ? <span className="ml-auto shrink-0 text-xs font-semibold text-danger">{problems}<span className="sr-only"> {problems === 1 ? "problem" : "problems"}</span></span> : null}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
      <div className="@container min-w-0 rounded-[var(--radius-card)] border border-line bg-surface p-3 rp-forced-border @md:p-5">
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">Phase {index + 1} of {stages.length}</p>
        <H id={`${uid}-guided-heading`} tabIndex={-1} className="mb-4 text-lg font-semibold break-words text-ink [overflow-wrap:anywhere]">{label(stage, index)}</H>
        {children}
        <div className="mt-6 flex flex-wrap justify-between gap-2 border-t border-line pt-4">
          <Button variant="secondary" leadingIcon={<ChevronLeft aria-hidden="true" />} disabled={index === 0} onClick={() => onIndex(index - 1)}>Previous phase</Button>
          <Button variant="secondary" trailingIcon={<ChevronRight aria-hidden="true" />} disabled={index >= stages.length - 1} onClick={() => onIndex(index + 1)}>Next phase</Button>
        </div>
      </div>
    </div>
  );
}
