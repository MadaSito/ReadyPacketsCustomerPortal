import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { errorMessage, useTRPC, useTRPCClient } from "@/lib/trpc";
import { Button, Callout, Checkbox, ConfirmSwitch, StepUpCancelledError, useStepUp, useToast } from "@/ui";
import type { DraftListRow, WorkflowListRow } from "./model";
import { WorkflowImportDialog } from "./WorkflowImportDialog";
import { downloadWorkflowFile } from "./transferFiles";

export function useWorkflowTransfer(workflows: readonly WorkflowListRow[], drafts: readonly DraftListRow[], refresh: () => void) {
  const trpc = useTRPC();
  const api = useTRPCClient();
  const stepUp = useStepUp();
  const toast = useToast();
  const queryClient = useQueryClient();
  const status = useQuery(trpc.orders.admin.workflows.transfer.status.queryOptions(undefined, { retry: false }));
  const canExport = !status.error && status.data?.enabled === true && status.data.canExport;
  const canImport = !status.error && status.data?.enabled === true && status.data.canImport;
  const maxWorkflows = status.data?.maxWorkflows ?? 0;
  const eligible = new Set([
    ...workflows.map(({ workflowKey }) => workflowKey),
    ...drafts.filter(({ workflowPublicId }) => !workflowPublicId).map(({ workflowKey }) => workflowKey),
  ]);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState<"all" | "selected" | { key: string } | null>(null);
  const [exportError, setExportError] = useState<string>();
  const exportLock = useRef(false);
  const selectedKeys = [...selection].filter((key) => eligible.has(key));
  const importOpen = Boolean(canImport && importing);
  const policies = useQuery(trpc.compliance.policies.listPublished.queryOptions(undefined, { enabled: importOpen }));

  const [switchError, setSwitchError] = useState<string>();
  /** Increment 06 (D10): the on-page switch (admin + workflows.manage; audited on the server). */
  async function setEnabled(enabled: boolean) {
    setSwitchError(undefined);
    try {
      await stepUp.run(() => api.orders.admin.workflows.transfer.setEnabled.mutate({ enabled }), { reason: enabled ? "Turning on workflow export and import." : "Turning off workflow export and import." });
      await queryClient.invalidateQueries({ queryKey: trpc.orders.admin.workflows.transfer.status.queryKey() });
      toast.show({ tone: "success", title: enabled ? "Workflow export and import turned on" : "Workflow export and import turned off" });
    } catch (error) {
      if (error instanceof StepUpCancelledError) return;
      setSwitchError(errorMessage(error, "The setting could not be saved. Please try again."));
      throw error;
    }
  }
  const canToggle = !status.error && status.data?.canToggle === true;
  const switchCard = canToggle ? (
    <section aria-label="Workflow export and import setting" className="grid min-w-0 gap-2 rounded-xl border border-line bg-surface p-4">
      <ConfirmSwitch
        id="workflow-transfer-switch"
        label="Workflow export and import"
        description={status.data?.enabled ? "On. Admins can download workflows as a file and import them as drafts." : "Off. Turn it on to download workflows as a file and import them as drafts. Imports never publish anything."}
        checked={status.data?.enabled === true}
        onConfirmedChange={(next) => setEnabled(next).catch(() => undefined)}
        confirmOff={{ title: "Turn off workflow export and import?", description: "Admins can no longer export or import workflows until it is turned on again. Existing workflows and drafts are not changed.", confirmLabel: "Turn off" }}
      />
      {switchError ? <Callout title="Setting not saved" tone="danger" live="assertive">{switchError}</Callout> : null}
    </section>
  ) : null;

  async function doExport(action: Exclude<typeof exporting, null>) {
    if (!canExport || exportLock.current) return;
    const workflowKeys = action === "all" ? [] : action === "selected" ? selectedKeys : [action.key];
    if (action !== "all" && (!workflowKeys.length || workflowKeys.length > maxWorkflows || workflowKeys.some((key) => !eligible.has(key)))) return;
    exportLock.current = true;
    setExportError(undefined);
    setExporting(action);
    try {
      const file = await api.orders.admin.workflows.transfer.export.mutate({ selection: action === "all" ? { all: true } : { workflowKeys } });
      downloadWorkflowFile(file.fileName, file.packageText);
      toast.show({ tone: "success", title: "Workflow export downloaded" });
    } catch (error) {
      setExportError(errorMessage(error, "The workflow export could not be downloaded. Please try again."));
    } finally {
      exportLock.current = false;
      setExporting(null);
    }
  }

  return {
    importAction: canImport ? <Button variant="secondary" onClick={() => setImporting(true)}>Import workflows</Button> : null,
    toolbar: <>{switchCard}{canExport ? <section aria-label="Workflow export" className="grid min-w-0 gap-2 rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <Button variant="secondary" loading={exporting === "selected"} disabled={exporting === "selected" ? false : !selectedKeys.length || selectedKeys.length > maxWorkflows || exporting !== null}
          onClick={() => void doExport("selected")}>Export selected</Button>
        <Button variant="secondary" loading={exporting === "all"} disabled={exporting === "all" ? false : !eligible.size || eligible.size > maxWorkflows || exporting !== null}
          onClick={() => void doExport("all")}>Export all</Button>
        <p role="status" className="text-sm text-muted">{selectedKeys.length} {selectedKeys.length === 1 ? "workflow" : "workflows"} selected</p>
      </div>
      {eligible.size > maxWorkflows ? <p className="text-sm text-muted">Select up to {maxWorkflows} workflows per export. Export all is unavailable because there are more than {maxWorkflows}.</p> : null}
      {exportError ? <Callout title="Export needs attention" tone="danger" live="assertive">{exportError}</Callout> : null}
    </section> : null}</>,
    selectionControl: (key: string, name: string) => canExport && eligible.has(key) ? <Checkbox
      label={<span className="[overflow-wrap:anywhere]">Select {name}</span>} checked={selection.has(key)}
      disabled={exporting !== null || (!selection.has(key) && selectedKeys.length >= maxWorkflows)}
      onCheckedChange={(checked) => setSelection((prior) => {
        const next = new Set([...prior].filter((item) => eligible.has(item)));
        if (!checked) next.delete(key);
        else if (next.size < maxWorkflows) next.add(key);
        return next;
      })} /> : null,
    exportAction: (key: string, name: string) => canExport && eligible.has(key) ? <Button size="sm" variant="secondary"
      aria-label={`Export ${name}`} loading={typeof exporting === "object" && exporting?.key === key} disabled={exporting !== null && !(typeof exporting === "object" && exporting.key === key)}
      onClick={() => void doExport({ key })}>Export</Button> : null,
    dialog: importOpen ? <WorkflowImportDialog close={() => setImporting(false)}
      policies={policies.error ? [] : policies.data ?? []}
      policyAvailability={policies.isPending || (policies.isFetching && policies.error) ? "loading" : policies.error ? "unavailable" : "ready"}
      reloadPolicies={() => void policies.refetch()}
      preview={(packageText) => stepUp.run(() => api.orders.admin.workflows.transfer.preview.mutate({ packageText }),
        { reason: "Validating a workflow package for import." })}
      apply={async (packageText, decisions, idempotencyKey) => {
        // Avoid placing package contents in the TanStack Query mutation cache.
        const result = await stepUp.run(() => api.orders.admin.workflows.transfer.applyImport.mutate({ packageText, idempotencyKey, ...decisions }),
          { reason: "Importing workflow drafts." });
        refresh();
        return result;
      }} /> : null,
  };
}
