/**
 * T2 — "Workflow stage actions" panel, mounted by the T1 Automation tab (siem engineer's slot; default export,
 * props `{ orderId }`). Owner: audit engineer. Server: `trpc.automations.orderStageActions.*` (engagement engineer).
 * Renders null for users without `orders.automations.run` (the server is authoritative and also refuses).
 * Running a step's actions is a confirmed, idempotent request; a disabled engine fails closed with a notice.
 */
import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { CheckCircle2, Play, Workflow } from "lucide-react";
import { roleHasCapability } from "@shared/capabilities";
import { Badge, Button, Callout, ConfirmDialog, DateTime, EmptyState, ErrorState, LoadMore, Section, Skeleton, useToast } from "@/ui";
import { useSession } from "@/lib/session";
import { errorMessage, safeError, useTRPC } from "@/lib/trpc";
import type { AutomationRunView, OrderStageStepView } from "@server/modules/automations/contracts";
import { RunStateBadge } from "./parts";

export interface OrderWorkflowStageActionsPanelProps {
  orderId: string;
}

function newIdempotencyKey(): string {
  return `stage:${crypto.randomUUID()}`;
}

export default function OrderWorkflowStageActionsPanel({ orderId }: OrderWorkflowStageActionsPanelProps) {
  const { me } = useSession();
  const role = me?.state === "full" ? me.user.role : null;
  const allowed = role !== null && roleHasCapability(role, "orders.automations.run");
  if (!allowed) return null;
  return <StageActions orderId={orderId} />;
}

function StageActions({ orderId }: OrderWorkflowStageActionsPanelProps) {
  const trpc = useTRPC();
  const view = useQuery(trpc.automations.orderStageActions.get.queryOptions({ orderPublicId: orderId, runLimit: 10 }));
  const [pending, setPending] = useState<{ step: OrderStageStepView; key: string } | null>(null);

  if (view.isError && safeError(view.error)?.domainCode === "FORBIDDEN") return null;
  return (
    <Section title="Workflow stage actions" description="Automations configured for each workflow step of this order. Running them queues the same actions the step would trigger.">
      {view.isPending ? (
        <Skeleton className="h-40" />
      ) : view.isError ? (
        <ErrorState title="Workflow stage actions could not be loaded" error={view.error} onRetry={() => view.refetch()} />
      ) : (
        <div className="min-w-0 space-y-4">
          {!view.data.engineEnabled ? (
            <Callout tone="warning" title="The automation engine is turned off">
              Stage actions cannot run until it is turned on.{" "}
              {view.data.canManageAutomations ? <Link className="font-medium underline" to={view.data.settingsPath}>Open automation settings</Link> : "Ask an administrator to turn it on."}
            </Callout>
          ) : null}
          <p className="text-sm text-muted">
            Workflow {view.data.workflowKey} (version {view.data.workflowVersionNumber})
          </p>
          {view.data.steps.length === 0 ? (
            <EmptyState headingLevel={3} icon={Workflow} title="No workflow steps" description="This order's workflow has no steps." />
          ) : (
            <ol className="divide-y divide-line rounded-lg border border-line" aria-label="Workflow steps">
              {view.data.steps.map((step) => (
                <li key={step.stepKey} className="flex min-w-0 flex-col gap-3 p-3 sm:flex-row sm:items-start sm:justify-between" aria-current={step.isCurrentOrderStep ? "step" : undefined}>
                  <div className="min-w-0 space-y-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                      <span className="break-words">{step.label}</span>
                      {step.isCurrentOrderStep ? <Badge tone="info" icon={<CheckCircle2 aria-hidden="true" className="size-3.5" />}>Current step</Badge> : null}
                    </p>
                    <p className="text-xs text-muted">
                      {step.configuredActionCount} configured action{step.configuredActionCount === 1 ? "" : "s"} in {step.configuredAutomationCount} automation{step.configuredAutomationCount === 1 ? "" : "s"}
                    </p>
                    {step.automations.length ? (
                      <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">
                        {pending?.step.automations.map((automation) => (
                          <li key={automation.publicId} className="break-words">
                            <span className="text-ink">{automation.name}</span>
                            {automation.actionLabels.length ? `: ${automation.actionLabels.join(", ")}` : ""}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                  <Button
                    variant="secondary"
                    leadingIcon={<Play aria-hidden="true" className="size-4" />}
                    className="shrink-0"
                    disabled={!view.data.engineEnabled || step.configuredAutomationCount === 0}
                    aria-label={`Run actions for ${step.label}`}
                    onClick={() => setPending({ step, key: newIdempotencyKey() })}
                  >
                    Run actions
                  </Button>
                </li>
              ))}
            </ol>
          )}
          <RecentRuns orderId={orderId} />
        </div>
      )}
      <RunConfirm orderId={orderId} pending={pending} onClose={() => setPending(null)} />
    </Section>
  );
}

/** Always mounted so the dialog can return focus to the step's trigger when it closes. */
function RunConfirm({ orderId, pending, onClose }: { orderId: string; pending: { step: OrderStageStepView; key: string } | null; onClose: () => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();
  const run = useMutation(trpc.automations.orderStageActions.runForOrder.mutationOptions());
  return (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={pending ? `Run actions for ${pending.step.label}?` : "Run actions?"}
      description="The configured automations for this step are queued now, even if the order is in a different step. Repeating this request does not queue them twice."
      confirmLabel="Run actions"
      onConfirm={async () => {
        if (!pending) return;
        try {
          const result = await run.mutateAsync({ orderPublicId: orderId, stepKey: pending.step.stepKey, idempotencyKey: pending.key });
          const fresh = result.queuedRuns.filter((r) => !r.deduplicated).length;
          toast.show({ tone: "success", title: `${fresh} automation run${fresh === 1 ? "" : "s"} queued`, description: fresh < result.queuedRuns.length ? "Some were already queued and were not repeated." : undefined });
          await queryClient.invalidateQueries(trpc.automations.orderStageActions.pathFilter());
          onClose();
        } catch (error) {
          toast.show({ tone: "danger", title: "Actions were not run", description: errorMessage(error) });
          throw error;
        }
      }}
    >
      <ul className="list-disc space-y-0.5 pl-5 text-sm">
        {pending?.step.automations.map((automation) => <li key={automation.publicId} className="break-words">{automation.name}</li>)}
      </ul>
    </ConfirmDialog>
  );
}

function RecentRuns({ orderId }: OrderWorkflowStageActionsPanelProps) {
  const trpc = useTRPC();
  const list = useInfiniteQuery(
    trpc.automations.orderStageActions.listRuns.infiniteQueryOptions({ orderPublicId: orderId, limit: 10 }, { getNextPageParam: (page) => page.nextCursor ?? undefined }),
  );
  const runs: AutomationRunView[] = list.data?.pages.flatMap((page): AutomationRunView[] => page.items) ?? [];
  return (
    <section aria-labelledby={`runs-${orderId}`} className="min-w-0 space-y-2">
      <h3 id={`runs-${orderId}`} className="text-base font-semibold text-ink">Recent runs for this order</h3>
      {list.isPending ? (
        <Skeleton className="h-20" />
      ) : list.isError ? (
        <ErrorState title="Recent runs could not be loaded" error={list.error} onRetry={() => list.refetch()} />
      ) : runs.length === 0 ? (
        <p className="text-sm text-muted">No automation runs for this order yet.</p>
      ) : (
        <>
          <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Recent automation runs">
            {runs.map((run) => (
              <li key={run.publicId} className="flex min-w-0 flex-wrap items-center gap-2 p-3 text-sm">
                <span className="min-w-0 break-words font-medium text-ink">{run.automationName}</span>
                <RunStateBadge state={run.state} />
                {run.stageStepKey ? <Badge>Step: {run.stageStepKey}</Badge> : null}
                <span className="w-full text-xs text-muted">
                  {run.triggeredBy ? `Run by ${run.triggeredBy.displayName}` : run.triggerKey ? `Triggered by ${run.triggerKey}` : "Triggered automatically"} · <DateTime value={run.queuedAt} />
                  {run.reasonCode ? ` · ${run.reasonCode}` : ""}
                </span>
              </li>
            ))}
          </ul>
          <LoadMore hasMore={Boolean(list.hasNextPage)} loading={list.isFetchingNextPage} onLoadMore={() => list.fetchNextPage()} summary={`Showing ${runs.length} run${runs.length === 1 ? "" : "s"}`} label="Load more runs" />
        </>
      )}
    </section>
  );
}
