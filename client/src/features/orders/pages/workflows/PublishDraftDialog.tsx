/**
 * Increment 08 (D7): the one publish dialog for workflow drafts. Used by the designer's persistent header button
 * and by the Publish row action on /admin/workflows. Same server procedure and validation as before
 * (`orders.admin.workflows.drafts.publish`, step-up, optimistic version); no new permission.
 * After publishing it stays open on a confirmation that names the version and whether it is now the default
 * for new orders. Owner: ui_foundation_engineer.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Upload } from "lucide-react";
import { useId, useRef, useState } from "react";
import { errorMessage, safeError, useTRPC } from "@/lib/trpc";
import { Button, Callout, Checkbox, Dialog, Field, StepUpCancelledError, Textarea, useStepUp } from "@/ui";
import { errorsOf, type WorkflowIssue } from "./model";

export interface PublishDraftTarget {
  publicId: string;
  name: string;
  rowVersion: number;
  /** The draft proposes a new workflow (not a new version of a published one). */
  newWorkflow: boolean;
}

export interface PublishResult {
  workflowPublicId: string;
  versionNumber: number;
  isDefault: boolean;
}

/** Reasons the Publish control is unavailable (empty = it may be used). Exported for tests and the designer. */
export function publishBlockers(input: { errorCount: number; busy?: boolean; nameMissing?: boolean }): string[] {
  const reasons: string[] = [];
  if (input.errorCount > 0) reasons.push(`Fix ${input.errorCount} problem${input.errorCount === 1 ? "" : "s"} in the draft first.`);
  if (input.nameMissing) reasons.push("Enter a name for the workflow.");
  if (input.busy) reasons.push("Wait until saving finishes.");
  return reasons;
}

/** The confirmation sentence after publishing (exported for tests). */
export function publishedSummary(name: string, result: Pick<PublishResult, "versionNumber" | "isDefault">): { title: string; detail: string } {
  return {
    title: `Version ${result.versionNumber} of “${name}” is published.`,
    detail: result.isDefault
      ? "It is now the default workflow for new orders. Existing orders keep the version they started on."
      : "It is not the default workflow, so new orders keep using the current default. You can change that with “Set as default” on the Workflows list. Existing orders keep the version they started on.",
  };
}

export interface PublishDraftDialogProps {
  draft: PublishDraftTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once the server has published (before the confirmation is shown). */
  onPublished?: (result: PublishResult) => void;
  /** The server refused the draft as invalid; the caller may show the issues next to the fields. */
  onInvalid?: (issues: WorkflowIssue[]) => void;
  /** Confirmation footer: an extra action (e.g. "View versions"). */
  confirmationAction?: (result: PublishResult) => React.ReactNode;
  /** Focus target when the dialog is cancelled (usually the opener). */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  /**
   * Focus target after a successful publish. The opener may disappear (a row action's draft leaves the drafts list),
   * so this must be persistent; defaults to the page's main landmark (`#main`, focusable with tabIndex -1).
   */
  publishedFocusTarget?: () => HTMLElement | null;
}

export function PublishDraftDialog({ draft, open, onOpenChange, onPublished, onInvalid, confirmationAction, returnFocusRef, publishedFocusTarget }: PublishDraftDialogProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const publish = useMutation(trpc.orders.admin.workflows.drafts.publish.mutationOptions());
  const [makeDefault, setMakeDefault] = useState(false);
  const [changeNote, setChangeNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [published, setPublished] = useState<PublishResult | null>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);
  const afterPublishFocus = useRef<HTMLElement | null>(null);
  const confirmationId = useId();

  // The drafts list is refreshed only when the confirmation closes: a row action's draft leaves that list once it
  // is published, and refreshing earlier would unmount the confirmation before it can be read.
  const finish = (next: boolean) => {
    if (!next && published) {
      // Resolve the persistent target now, before the list refetch can remove the opener.
      afterPublishFocus.current = publishedFocusTarget?.() ?? document.getElementById("main");
      void queryClient.invalidateQueries({ queryKey: trpc.orders.admin.workflows.drafts.list.queryKey() });
    }
    onOpenChange(next);
  };
  const close = () => finish(false);

  const run = async () => {
    setProblem(null);
    try {
      const result = await stepUp.run(
        () => publish.mutateAsync({ draftId: draft.publicId, expectedVersion: draft.rowVersion, makeDefault, ...(changeNote.trim() ? { changeNote: changeNote.trim() } : {}) }),
        { reason: "Publishing a workflow changes how new orders move." },
      );
      // No toast: the focused confirmation below is the single announcement.
      setPublished(result);
      onPublished?.(result);
      void queryClient.invalidateQueries({ queryKey: trpc.orders.admin.workflows.list.queryKey() });
      // Move focus to the confirmation so it is read out (the publish button no longer exists).
      window.setTimeout(() => confirmationRef.current?.focus(), 0);
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      // WORKFLOW_DRAFT_INVALID carries parallel arrays: messages, field paths and codes (all errors).
      const details = safeError(err)?.details as { issues?: unknown; issuePaths?: unknown; issueCodes?: unknown } | undefined;
      if (Array.isArray(details?.issues)) {
        const paths = Array.isArray(details.issuePaths) ? details.issuePaths : [];
        const codes = Array.isArray(details.issueCodes) ? details.issueCodes : [];
        const issues = details.issues.map((message, i) => ({ severity: "error" as const, message: String(message), path: String(paths[i] ?? ""), code: String(codes[i] ?? "") }));
        onInvalid?.(issues);
        setProblem(`The draft has ${errorsOf(issues).length || issues.length} problem(s) to fix before it can be published.`);
        return;
      }
      setProblem(errorMessage(err, "The workflow could not be published. Please try again."));
    }
  };

  if (published) {
    const summary = publishedSummary(draft.name, published);
    return (
      <Dialog
        open={open}
        onOpenChange={finish}
        title="Workflow published"
        returnFocusRef={afterPublishFocus}
        footer={
          <>
            {confirmationAction?.(published)}
            <Button onClick={close}>Done</Button>
          </>
        }
      >
        <div ref={confirmationRef} tabIndex={-1} role="status" aria-labelledby={confirmationId} className="flex items-start gap-3 rounded-[var(--radius-control)] outline-none" data-testid="workflow-published">
          <CheckCircle2 aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-success" />
          <div className="min-w-0 break-words">
            <p id={confirmationId} className="font-semibold text-ink">
              {summary.title}
            </p>
            <p className="mt-1 text-sm text-body">{summary.detail}</p>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (publish.isPending ? undefined : onOpenChange(next))}
      dismissible={!publish.isPending}
      title={`Publish “${draft.name}”?`}
      description={
        draft.newWorkflow
          ? "Publishing creates version 1 of this new workflow. Orders already in progress are not affected."
          : "Publishing creates a new version. Orders already in progress keep the version they started on."
      }
      returnFocusRef={returnFocusRef}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={publish.isPending}>
            Cancel
          </Button>
          <Button leadingIcon={<Upload aria-hidden="true" />} loading={publish.isPending} onClick={() => void run()} data-testid="publish-draft-confirm">
            Publish
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {problem ? (
          <Callout tone="danger" live="assertive">
            {problem}
          </Callout>
        ) : null}
        <Checkbox
          label="Use for new orders (default workflow)"
          description={
            draft.newWorkflow
              ? "If you leave this off, new orders keep using the current default. You can choose it later with “Set as default” on the Workflows list."
              : "If you leave this off, the current default stays as it is. You can change it any time with “Set as default” on the Workflows list."
          }
          checked={makeDefault}
          onCheckedChange={setMakeDefault}
          disabled={publish.isPending}
        />
        <Field label="Change note (optional)" hint="Shown in the version list, for example why the change was made.">
          <Textarea value={changeNote} maxLength={500} rows={3} disabled={publish.isPending} onChange={(event) => setChangeNote(event.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

/**
 * Publish row action for the /admin/workflows drafts table: shown only for drafts that validate (errorCount 0),
 * opens the same dialog. Mounted by AdminWorkflowsPage (orders_engineer).
 */
export function PublishDraftRowAction({ draft, publishedFocusTarget }: { draft: PublishDraftTarget & { errorCount: number }; publishedFocusTarget?: () => HTMLElement | null }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  if (draft.errorCount > 0) return null;
  return (
    <>
      <Button ref={opener} size="sm" variant="secondary" aria-label={`Publish draft ${draft.name}`} onClick={() => setOpen(true)} data-testid="publish-draft-row">
        Publish
      </Button>
      {open ? <PublishDraftDialog draft={draft} open onOpenChange={setOpen} returnFocusRef={opener} publishedFocusTarget={publishedFocusTarget} /> : null}
    </>
  );
}
