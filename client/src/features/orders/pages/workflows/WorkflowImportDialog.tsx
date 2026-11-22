import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import type { TransferApplyInput, TransferApplyResult, TransferPreview } from "@server/modules/orders";
import { errorMessage, safeError } from "@/lib/trpc";
import { Badge, Button, Callout, Checkbox, Dialog, Field, Input, Select, StepUpCancelledError, Wizard } from "@/ui";
import { newIdempotencyKey } from "../../shared";
import { readWorkflowFile, workflowFileProblem } from "./transferFiles";

/**
 * Runs a focus check on the next frame and again shortly afterwards. A closing nested dialog restores focus
 * asynchronously, sometimes after the first frame, so one check is not enough. The checks stop as soon as
 * the user presses a key or pointer, so focus the user has chosen is never moved. Returns a cancel function.
 */
function settleFocus(check: () => void): () => void {
  const frame = requestAnimationFrame(check);
  const timers = [60, 180, 400].map((delay) => window.setTimeout(check, delay));
  const cancel = () => {
    cancelAnimationFrame(frame);
    for (const timer of timers) window.clearTimeout(timer);
    document.removeEventListener("keydown", cancel, true);
    document.removeEventListener("pointerdown", cancel, true);
  };
  document.addEventListener("keydown", cancel, true);
  document.addEventListener("pointerdown", cancel, true);
  timers.push(window.setTimeout(cancel, 450));
  return cancel;
}

type WorkflowChoice = TransferApplyInput["decisions"][number]["action"];
type Step = "file" | "plan" | "confirm";
const steps = [
  { id: "file", label: "Choose a package" },
  { id: "plan", label: "Review import plan" },
  { id: "confirm", label: "Confirm draft import" },
];
const remove = "remove-gate";

type WorkflowImportDecisions = Pick<TransferApplyInput, "decisions" | "policyMappings">;

export function WorkflowImportDialog({ close, preview, apply, policies, policyAvailability, reloadPolicies }: {
  close: () => void;
  preview: (json: string) => Promise<TransferPreview>;
  apply: (json: string, decisions: WorkflowImportDecisions, idempotencyKey: string) => Promise<TransferApplyResult>;
  policies: readonly { documentPublicId: string; title: string; slug: string; audience: string }[];
  policyAvailability: "loading" | "unavailable" | "ready";
  reloadPolicies: () => void;
}) {
  const [step, setStep] = useState<Step>("file");
  const [file, setFile] = useState<File>();
  const [packageText, setPackageText] = useState("");
  const [plan, setPlan] = useState<TransferPreview>();
  const [choices, setChoices] = useState<ReadonlyMap<string, WorkflowChoice>>(new Map());
  const [mappings, setMappings] = useState<ReadonlyMap<string, string>>(new Map());
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fileError, setFileError] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [highlightReviewErrors, setHighlightReviewErrors] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [result, setResult] = useState<TransferApplyResult>();
  const attempt = useRef<{ signature: string; key: string }>(null);
  const previewLauncher = useRef<Element | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const wizardRoot = useRef<HTMLDivElement>(null);
  const reviewFields = useRef<HTMLDivElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (step === "plan" && highlightReviewErrors && problem) {
      reviewFields.current?.querySelector<HTMLSelectElement>("select[aria-invalid=true]")?.focus();
    }
  }, [step, problem, highlightReviewErrors]);
  useEffect(() => {
    if (!result) return;
    resultHeading.current?.focus();
    // A nested step-up dialog can restore focus as it unmounts; keep the receipt reachable after its cleanup.
    return settleFocus(() => {
      if (!resultHeading.current?.closest("[role=dialog]")?.contains(document.activeElement)) resultHeading.current?.focus();
    });
  }, [result]);
  useEffect(() => {
    if (step !== "plan" || !previewLauncher.current) return;
    const launcher = previewLauncher.current;
    previewLauncher.current = null;
    // The step-up dialog closes after the plan arrives and then restores focus to the launcher, which is
    // gone by now. Focus the step heading unless the user has already moved inside this dialog.
    return settleFocus(() => {
      const root = wizardRoot.current;
      const dialog = root?.closest("[role=dialog]") ?? root;
      if (document.activeElement === launcher || !dialog?.contains(document.activeElement)) {
        root?.querySelector<HTMLHeadingElement>("form > h2")?.focus();
      }
    });
  }, [step]);

  const chosen = plan?.workflows.filter((workflow) => choices.has(workflow.key) && choices.get(workflow.key) !== "skip") ?? [];
  const chosenKeys = new Set(chosen.map(({ key }) => key));
  const applicable = plan?.references.policies.filter((reference) => reference.usedBy.some((key) => chosenKeys.has(key))) ?? [];
  const unresolved = applicable.filter(({ resolution }) => resolution.status === "not_found");
  const unfinished = Boolean(plan?.workflows.some((workflow) => workflow.valid && !choices.has(workflow.key)));
  const policyOptions = policies.filter(({ audience }) => audience === "all" || audience === "customer");
  const missingMapping = (ref: string) => {
    const value = mappings.get(ref);
    return value !== remove && !policyOptions.some((policy) => policy.documentPublicId === value);
  };
  const needsMapping = unresolved.some(({ ref }) => missingMapping(ref));

  async function next() {
    if (busy) return;
    setProblem(undefined);
    if (step === "file") {
      if (!file || fileError) {
        if (!fileError) setFileError("Choose a workflow package first.");
        fileInput.current?.focus();
        return;
      }
      setBusy(true);
      previewLauncher.current = document.activeElement;
      try {
        let json: string;
        try { json = await readWorkflowFile(file); }
        catch (error) {
          setFileError(error instanceof Error ? error.message : "The package could not be read.");
          fileInput.current?.focus();
          return;
        }
        const reviewed = await preview(json);
        setPackageText(json);
        setPlan(reviewed);
        setChoices(new Map(reviewed.workflows.filter((workflow) => !workflow.valid).map((workflow) => [workflow.key, "skip"])));
        setMappings(new Map());
        setAcknowledged(false);
        setHighlightReviewErrors(false);
        attempt.current = null;
        setStep("plan");
      } catch (error) {
        setProblem(error instanceof StepUpCancelledError ? "Verification was cancelled. You can preview the package again."
          : errorMessage(error, "The package could not be previewed. Check the file and try again."));
      } finally { setBusy(false); }
      return;
    }
    if (step === "plan") {
      if (plan?.blocking.length) return;
      setHighlightReviewErrors(true);
      if (unfinished) setProblem("Choose what to do with each workflow.");
      else if (!chosen.length) setProblem("Choose at least one workflow to import as a draft.");
      else if (needsMapping) setProblem("Resolve every missing policy by choosing a local policy or removing the gate.");
      else {
        setAcknowledged(false);
        setStep("confirm");
      }
      return;
    }
    if (!plan || plan.blocking.length || needsMapping) {
      setStep("plan");
      setProblem("Review the import plan and resolve any missing policies before importing.");
      return;
    }
    if (!acknowledged) {
      setProblem("Confirm that you understand the import creates drafts only.");
      return;
    }
    const decisions: WorkflowImportDecisions = {
      decisions: plan.workflows.map(({ key }) => ({ key, action: choices.get(key) ?? "skip" })),
      policyMappings: unresolved.flatMap<WorkflowImportDecisions["policyMappings"][number]>(({ ref }) => {
        const policyId = mappings.get(ref);
        if (!policyId) return [];
        return policyId === remove ? [{ ref, removeGates: true }] : [{ ref, localPolicyPublicId: policyId }];
      }),
    };
    const signature = JSON.stringify(decisions);
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: newIdempotencyKey() };
    const key = attempt.current.key;
    setBusy(true);
    try {
      const receipt = await apply(packageText, decisions, key);
      setPackageText("");
      setFile(undefined);
      setResult(receipt);
    } catch (error) {
      const code = safeError(error)?.domainCode;
      if (error instanceof StepUpCancelledError) setProblem("Verification was cancelled. No import was submitted.");
      else if (code && ["BAD_INPUT", "VALIDATION", "FORBIDDEN", "NOT_FOUND", "STEP_UP_REQUIRED", "CONFLICT", "RATE_LIMITED"].includes(code)) {
        setProblem(errorMessage(error));
      } else {
        setUncertain(true);
        setProblem("The result could not be confirmed. Retry this same import to recover the result, or check the draft list before starting another import.");
      }
    } finally { setBusy(false); }
  }

  return <Dialog open dismissible={!busy} onOpenChange={(open) => { if (!open && !busy) close(); }} title="Import workflows"
    description="Transfer workflow definitions between ReadyPackets portals. Imported workflows are drafts; nothing is published."
    size="lg" initialFocusRef={fileInput}>
    {result ? <div className="grid min-w-0 gap-4">
      <div role="status">
        <h2 tabIndex={-1} ref={resultHeading} className="text-lg font-semibold text-ink">Import result</h2>
        <p className="text-sm text-body">{draftCountText(result.results.filter((workflow) => workflow.draftPublicId).length)} Review each draft before publishing.</p>
        {result.replayed ? <p className="text-sm text-muted">Showing the result of the original import. No duplicate drafts were created.</p> : null}
      </div>
      <ul className="grid min-w-0 gap-2">
        {result.results.map((workflow) => <li key={workflow.key} className="min-w-0 break-words rounded-lg border border-line p-3 [overflow-wrap:anywhere]">
          {workflow.draftPublicId ? <Link href={`/admin/workflows/drafts/${encodeURIComponent(workflow.draftPublicId)}`}
            className="font-semibold text-link underline underline-offset-2">Review draft: {workflow.workflowKey ?? workflow.key}</Link>
            : <p>{workflow.key}: Skipped</p>}
        </li>)}
      </ul>
      <Button className="justify-self-start" onClick={close}>Done</Button>
    </div> : <div ref={wizardRoot}><Wizard steps={steps} current={step} busy={busy} onNext={() => void next()} nextDisabled={step === "plan" && Boolean(plan?.blocking.length)}
      completed={step === "confirm" ? ["file", "plan"] : step === "plan" ? ["file"] : []}
      nextLabel={step === "file" ? "Preview package" : step === "plan" ? "Continue" : uncertain ? "Retry same import" : "Import drafts"}
      {...(step !== "file" && !uncertain ? { onBack: () => { setProblem(undefined); setStep(step === "confirm" ? "plan" : "file"); } } : {})}
      secondaryAction={<Button variant="secondary" onClick={close} disabled={busy}>{uncertain ? "Close" : "Cancel"}</Button>}>
      {problem ? <Callout tone="danger" title="Import needs attention" live="assertive">{problem}</Callout> : null}
      {step === "file" ? <>
        <Field label="Workflow package" hint="Choose a ReadyPackets JSON file, up to 2 MB." required {...(fileError ? { error: <span aria-live="polite">{fileError}</span> } : {})}>
          <Input ref={fileInput} className="w-full min-w-0" type="file" accept=".json,application/json" disabled={busy}
            onChange={(event) => {
              const selected = event.currentTarget.files?.[0];
              setFile(selected);
              const invalid = selected && workflowFileProblem(selected);
              setFileError(invalid);
              setProblem(undefined);
              if (invalid) event.currentTarget.value = "";
            }} />
        </Field>
        {file && !fileError ? <p className="break-words text-sm text-body [overflow-wrap:anywhere]">Selected file: {file.name}</p> : null}
      </> : null}
      {step === "plan" && plan?.blocking.length ? <Callout tone="danger" title="This package cannot be imported" live="assertive">
        <ul className="grid gap-1 pl-5 [overflow-wrap:anywhere]">
          {plan.blocking.map(({ code, message }, index) => <li className="list-disc" key={`${code}:${index}`}>{message}</li>)}
        </ul>
      </Callout> : null}
      {step === "plan" && plan && !plan.blocking.length ? <div ref={reviewFields} className="grid min-w-0 gap-4">
        <p className="text-sm text-body">Choose an action for each valid workflow. Invalid workflows can only be skipped.</p>
        {plan.workflows.map((workflow) => <fieldset key={workflow.key}
          className="grid min-w-0 gap-3 rounded-lg border border-line p-3">
          <legend className="max-w-full px-1 font-semibold text-ink [overflow-wrap:anywhere]">{workflow.name} ({workflow.key})</legend>
          <div className="flex flex-wrap gap-2">
            <Badge tone={workflow.valid ? "success" : "danger"}>{workflow.valid ? "Valid" : "Invalid"}</Badge>
            {workflow.unpublished ? <Badge tone="neutral">Unpublished at source</Badge> : null}
            {workflow.existing ? <Badge tone="info">Matching workflow</Badge> : null}
          </div>
          {workflow.existing ? <p className="text-sm text-body [overflow-wrap:anywhere]">
            Existing: {workflow.existing.name}.{workflow.existing.hasDraft ? " It already has an open draft." : ""}
          </p> : null}
          {workflow.findings.length ? <ul className="grid gap-1 pl-5 text-sm [overflow-wrap:anywhere]">
            {workflow.findings.map((finding, index) => <li key={`${finding.code}:${finding.path}:${index}`} className="list-disc">
              <span className="font-semibold">{finding.severity === "warning" ? "Warning: " : "Error: "}</span>
              {finding.path ? <span className="font-mono">{finding.path}: </span> : null}<span>{finding.message}</span>
            </li>)}
          </ul> : null}
          <Field label={<span className="[overflow-wrap:anywhere]">Action for {workflow.name}</span>}
            error={highlightReviewErrors && workflow.valid && !choices.has(workflow.key) ? "Choose an action for this workflow." : undefined}>
            <Select className="w-full" disabled={!workflow.valid || busy} value={choices.get(workflow.key) ?? ""} placeholder="Choose an action"
              options={[{ value: "create", label: "Create as new workflow" },
                { value: "draft", label: "Add as a draft of the existing workflow", disabled: !workflow.existing?.workflowPublicId || workflow.existing.hasDraft },
                { value: "skip", label: "Skip" }]}
              onChange={(event) => {
                const action = event.currentTarget.value;
                setProblem(undefined);
                setChoices((prior) => {
                  const next = new Map(prior);
                  if (action === "create" || action === "draft" || action === "skip") next.set(workflow.key, action);
                  else next.delete(workflow.key);
                  return next;
                });
              }} />
          </Field>
          {choices.get(workflow.key) === "create" && workflow.suggestedKey ? <p className="text-sm text-muted [overflow-wrap:anywhere]">
            Suggested key: {workflow.suggestedKey}
          </p> : null}
        </fieldset>)}
        {unresolved.length ? <section className="grid min-w-0 gap-3" aria-label="Missing policies">
          <h3 className="font-semibold text-ink">Missing policies</h3>
          <p className="text-sm text-body">Choose a local policy or explicitly remove the gate. Removing it changes only the imported draft.</p>
          {policyAvailability === "loading" ? <p role="status" className="text-sm text-muted">Loading local policies…</p> : null}
          {policyAvailability === "unavailable" ? <Callout tone="warning" title="Local policies unavailable">
            <div className="flex flex-wrap items-center gap-2">
              <p>Try loading local policies again, or choose to remove the gate.</p>
              <Button variant="secondary" onClick={reloadPolicies}>Reload local policies</Button>
            </div>
          </Callout> : null}
          {unresolved.map((reference) => <Field key={reference.ref} required
            label={<span className="[overflow-wrap:anywhere]">Map {reference.title} ({reference.slug})</span>}
            error={highlightReviewErrors && missingMapping(reference.ref) ? "Choose a local policy or remove this gate." : undefined}>
            <Select className="w-full" value={mappings.get(reference.ref) ?? ""} placeholder="Choose a mapping"
              options={[...policyOptions.map((policy) => ({ value: policy.documentPublicId, label: `${policy.title} (${policy.slug})` })),
                { value: remove, label: "Remove this gate" }]}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setProblem(undefined);
                setMappings((prior) => new Map(prior).set(reference.ref, value));
              }} />
          </Field>)}
        </section> : null}
      </div> : null}
      {step === "confirm" ? <>
        <Callout tone="info" title="Drafts only">No workflow is published, the default stays the same, and existing orders are not changed.</Callout>
        <ul className="grid min-w-0 gap-1 pl-5 [overflow-wrap:anywhere]">
          {chosen.map((workflow) => <li key={workflow.key} className="list-disc">
            {workflow.name}: {choices.get(workflow.key) === "draft" ? "Add as a draft of the existing workflow" : "Create as new workflow"}
          </li>)}
        </ul>
        {applicable.length ? <section className="grid min-w-0 gap-2" aria-label="Policy decisions">
          <h3 className="font-semibold text-ink">Policy decisions</h3>
          <ul className="grid gap-1 pl-5 [overflow-wrap:anywhere]">
            {applicable.map((reference) => <li className="list-disc" key={reference.ref}>
              {reference.title}: {reference.resolution.status === "matched" ? `Matched to ${reference.resolution.title}`
                : mappings.get(reference.ref) === remove ? "Remove the gate"
                  : `Use ${policies.find((policy) => policy.documentPublicId === mappings.get(reference.ref))?.title ?? "selected local policy"}`}
            </li>)}
          </ul>
        </section> : null}
        <p className="text-sm text-body">You may be asked to verify your identity before importing.</p>
        <Checkbox label="I understand that this import creates drafts only" checked={acknowledged} onCheckedChange={setAcknowledged} disabled={busy || uncertain} />
      </> : null}
    </Wizard></div>}
  </Dialog>;
}

function draftCountText(count: number) {
  return `${count} ${count === 1 ? "draft" : "drafts"} created.`;
}
