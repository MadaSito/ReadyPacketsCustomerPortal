/**
 * Order console Automation panel (`OrderWorkflowStageActionsPanel`).
 * Mounted on `/admin/orders/:orderId/automation` (full order view) and optionally inside a single phase panel
 * (`stageKey` prop, D4 `OrderPhaseConsolePanel`).
 *
 * Owner: siem_engineer (Increment 07 Package G client).
 * Server: `trpc.automations.orderStageActions.*` (engagement_engineer).
 */
import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, Clock, Eye, Play, Workflow, XCircle } from "lucide-react";
import { roleHasCapability } from "@shared/capabilities";
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  DateTime,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadMore,
  Section,
  Skeleton,
  StepUpCancelledError,
  Textarea,
  useStepUp,
  useToast,
} from "@/ui";
import { useSession } from "@/lib/session";
import { errorMessage, safeError } from "@/lib/trpc";
import type {
  AutomationRunView,
  OrderCompletionJobView,
  OrderPhaseBundleView,
  OrderStageBundlePreviewView,
  OrderStageRunView,
  OrderStageStepView,
  RunOrderStageBundleResult,
  StageBundleSlotKey,
  StageBundleSlotPreview,
  StageBundleSlotResult,
} from "@server/modules/automations/contracts";
import { useAutomationsApi } from "./api";
import {
  CompletionJobStateBadge,
  RunStateBadge,
  StageRunStateBadge,
  StageSlotOutcomeBadge,
} from "./parts";

const PRODUCTION_WEBHOOKS_PATH = "/admin/integrations/production";
const OUTBOUND_WEBHOOKS_PATH = "/admin/integrations/webhooks";

const SLOT_FRIENDLY_LABELS: Readonly<Record<StageBundleSlotKey, string>> = {
  status: "Order status",
  completion: "Completion percentage",
  email: "Customer email",
  webhook: "Workflow webhook",
  dashboard_alert: "Operational alert",
};

function slotFriendlyLabel(slot: StageBundleSlotKey): string {
  return SLOT_FRIENDLY_LABELS[slot] ?? slot.replace(/_/g, " ");
}

function firstLine(text: string): string {
  const idx = text.indexOf("\n");
  return (idx >= 0 ? text.slice(0, idx) : text).trim();
}

/** Replaces server ASCII path hints with UI wording ("Integrations → Production webhooks"). */
export function normalizeIntegrationNoticeText(text: string): string {
  return text
    .replace(/Integrations\s*(?:->|→)\s*Production(?:\s+webhooks)?\b/g, "Integrations → Production webhooks")
    .replace(/Integrations\s*(?:->|→)\s*Webhooks\b/g, "Integrations → Webhooks");
}

function IntegrationLinkedText({
  text,
  canLinkProduction,
  canLinkWebhooks,
  onNavigate,
}: {
  text: string;
  canLinkProduction: boolean;
  canLinkWebhooks: boolean;
  onNavigate?: () => void;
}) {
  const normalized = normalizeIntegrationNoticeText(text);
  const parts = normalized.split(/(Integrations → Production webhooks|Integrations → Webhooks)/g);
  return (
    <>
      {parts.map((part, idx) => {
        if (!part) return null;
        if (part === "Integrations → Production webhooks" && canLinkProduction) {
          return (
            <Link
              key={idx}
              to={PRODUCTION_WEBHOOKS_PATH}
              onClick={onNavigate}
              className="font-semibold text-ink underline underline-offset-2 hover:text-action"
            >
              {part}
            </Link>
          );
        }
        if (part === "Integrations → Webhooks" && canLinkWebhooks) {
          return (
            <Link
              key={idx}
              to={OUTBOUND_WEBHOOKS_PATH}
              onClick={onNavigate}
              className="font-semibold text-ink underline underline-offset-2 hover:text-action"
            >
              {part}
            </Link>
          );
        }
        return <span key={idx}>{part}</span>;
      })}
    </>
  );
}

interface StageRunOutcomeSummary {
  doneCount: number;
  skippedCount: number;
  failedCount: number;
  hasWarningOrFailure: boolean;
  /** e.g. "3 done, 1 skipped" */
  commaCounts: string;
  /** e.g. "3 done · 1 skipped" */
  dotCounts: string;
  /** Failed slots first, then operational skips (e.g. webhooks), then idempotent ALREADY_IN_STATUS skips. */
  notableResults: StageBundleSlotResult[];
}

function summarizeStageRun(run: Pick<OrderStageRunView, "state" | "results">): StageRunOutcomeSummary {
  const doneCount = run.results.filter(
    (r) => r.outcome === "completed" || r.outcome === "scheduled",
  ).length;
  const skippedResults = run.results.filter((r) => r.outcome === "skipped");
  const failedResults = run.results.filter((r) => r.outcome === "failed");
  const skippedCount = skippedResults.length;
  const failedCount = failedResults.length;

  const parts: string[] = [];
  if (doneCount > 0 || (skippedCount === 0 && failedCount === 0)) {
    parts.push(`${doneCount} done`);
  }
  if (skippedCount > 0) parts.push(`${skippedCount} skipped`);
  if (failedCount > 0) parts.push(`${failedCount} failed`);

  const notableResults: StageBundleSlotResult[] = [
    ...failedResults,
    ...skippedResults.filter((r) => r.reasonCode !== "ALREADY_IN_STATUS"),
    ...skippedResults.filter((r) => r.reasonCode === "ALREADY_IN_STATUS"),
  ];

  return {
    doneCount,
    skippedCount,
    failedCount,
    hasWarningOrFailure: skippedCount > 0 || failedCount > 0 || run.state !== "completed",
    commaCounts: parts.join(", "),
    dotCounts: parts.join(" · "),
    notableResults,
  };
}

function slotWillBeSkipped(
  slot: StageBundleSlotPreview,
  statusTransition: OrderStageBundlePreviewView["statusTransition"],
): boolean {
  if (slot.slot === "status") {
    return Boolean(statusTransition?.alreadyInTargetStatus) || /\(will skip\)/i.test(slot.summary);
  }
  if (slot.slot === "webhook" && slot.warning) {
    return !/no longer exists/i.test(slot.warning);
  }
  return /\(will skip\)/i.test(slot.summary) || /will be skipped/i.test(slot.warning ?? "");
}

export interface OrderWorkflowStageActionsPanelProps {
  orderId: string;
  /** Optional phase filter when embedded inside a single phase console panel (D4). */
  stageKey?: string;
}

function newStepIdempotencyKey(): string {
  return `stage:${crypto.randomUUID()}`;
}

function newBundleIdempotencyKey(): string {
  return `bundle:${crypto.randomUUID()}`;
}

export default function OrderWorkflowStageActionsPanel({
  orderId,
  stageKey,
}: OrderWorkflowStageActionsPanelProps) {
  const { me } = useSession();
  const role = me?.state === "full" ? me.user.role : null;
  const allowed =
    role !== null &&
    (roleHasCapability(role, "orders.stage.run") || roleHasCapability(role, "orders.automations.run"));
  if (!allowed) return null;
  return <StageActions orderId={orderId} stageKey={stageKey} role={role} />;
}

interface PendingBundleState {
  stageKey: string;
  stageLabel: string;
  idempotencyKey: string;
}

function StageActions({
  orderId,
  stageKey,
  role,
}: OrderWorkflowStageActionsPanelProps & { role: "admin" | "staff" | "customer" }) {
  const api = useAutomationsApi();
  const view = useQuery(api.orderStageActions.get.queryOptions({ orderPublicId: orderId, runLimit: 10 }));
  const [pendingStep, setPendingStep] = useState<{ step: OrderStageStepView; key: string } | null>(null);
  const [pendingBundle, setPendingBundle] = useState<PendingBundleState | null>(null);
  const [pendingCancelJob, setPendingCancelJob] = useState<OrderCompletionJobView | null>(null);
  const [latestRunResult, setLatestRunResult] = useState<RunOrderStageBundleResult | null>(null);
  const [latestRunAnnouncement, setLatestRunAnnouncement] = useState("");

  if (view.isError && safeError(view.error)?.domainCode === "FORBIDDEN") return null;

  const data = view.data;
  const hasPhaseModel = Boolean(data && Array.isArray(data.stages));
  const stages: readonly OrderPhaseBundleView[] = data?.stages
    ? stageKey
      ? data.stages.filter((s) => s.stageKey === stageKey)
      : data.stages
    : [];
  const steps: readonly OrderStageStepView[] = data?.steps
    ? stageKey
      ? data.steps.filter((s) => s.phaseKey === stageKey || s.stepKey === stageKey)
      : data.steps
    : [];

  const stageLabelsByKey = new Map<string, string>();
  for (const st of data?.steps ?? []) {
    if (st.phaseKey) stageLabelsByKey.set(st.phaseKey, st.label);
    stageLabelsByKey.set(st.stepKey, st.label);
  }
  for (const st of data?.stages ?? []) {
    stageLabelsByKey.set(st.stageKey, st.staffLabel);
  }

  const stageBundlesEnabled = data?.stageBundlesEnabled ?? false;
  const canRunBundles = data?.canRunStageBundles ?? roleHasCapability(role, "orders.stage.run");
  const canCancelJobs = data?.canCancelCompletionJobs ?? role === "admin";
  const canLinkProduction = roleHasCapability(role, "integrations.manage");
  const canLinkWebhooks = roleHasCapability(role, "webhooks.manage");

  const visibleRunResult =
    latestRunResult && (!stageKey || latestRunResult.stageRun.stageKey === stageKey)
      ? latestRunResult
      : null;
  const visibleRunSummary = visibleRunResult
    ? summarizeStageRun(visibleRunResult.stageRun)
    : null;
  const visibleRunTitle =
    visibleRunResult && visibleRunSummary
      ? visibleRunResult.deduplicated
        ? `Phase actions already run: ${visibleRunSummary.commaCounts}`
        : `Phase actions run: ${visibleRunSummary.commaCounts}`
      : null;

  return (
    <Section
      title={stageKey ? "Phase actions" : "Workflow stage actions"}
      description={
        stageKey
          ? "Preview and run the pinned actions for this phase, inspect run outcomes, or manage scheduled completion updates."
          : "Administrator-run phase bundles and workflow step automations pinned to this order's workflow version."
      }
    >
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {latestRunAnnouncement}
      </p>

      {view.isPending ? (
        <Skeleton className="h-40" />
      ) : view.isError ? (
        <ErrorState
          title="Workflow stage actions could not be loaded"
          error={view.error}
          onRetry={() => view.refetch()}
        />
      ) : !data ? null : (
        <div className="min-w-0 space-y-6">
          {visibleRunResult && visibleRunSummary && visibleRunTitle ? (
            <Callout
              tone={visibleRunSummary.hasWarningOrFailure ? "warning" : "success"}
              title={`${visibleRunTitle} (${visibleRunResult.stageRun.stageLabel})`}
              actions={
                <Button size="sm" variant="ghost" onClick={() => setLatestRunResult(null)}>
                  Dismiss
                </Button>
              }
            >
              {visibleRunResult.deduplicated ? (
                <p>This confirmation was already processed and was not repeated.</p>
              ) : visibleRunSummary.notableResults.length > 0 ? (
                <ul className="space-y-1 text-xs">
                  {visibleRunSummary.notableResults.map((slotResult) => {
                    const isFailed = slotResult.outcome === "failed";
                    const summaryLine = firstLine(slotResult.safeSummary);
                    const needsProdLink =
                      slotResult.slot === "webhook" &&
                      /production webhook/i.test(summaryLine) &&
                      !/Integrations/i.test(summaryLine);
                    return (
                      <li key={slotResult.slot} className="break-words">
                        <span className="font-semibold">
                          {isFailed ? "Failed" : "Skipped"} ({slotFriendlyLabel(slotResult.slot)}):
                        </span>{" "}
                        <IntegrationLinkedText
                          text={summaryLine}
                          canLinkProduction={canLinkProduction}
                          canLinkWebhooks={canLinkWebhooks}
                        />
                        {needsProdLink ? (
                          <>
                            {" ("}
                            <IntegrationLinkedText
                              text="Integrations → Production webhooks"
                              canLinkProduction={canLinkProduction}
                              canLinkWebhooks={canLinkWebhooks}
                            />
                            {")"}
                          </>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : visibleRunResult.completionJob ? (
                <p>Scheduled {visibleRunResult.completionJob.resolvedPercent}% completion update.</p>
              ) : (
                <p>All configured actions for this phase completed.</p>
              )}
            </Callout>
          ) : null}

          {!data.engineEnabled ? (
            <Callout tone="warning" title="The automation engine is turned off">
              Stage actions cannot run until it is turned on.{" "}
              {data.canManageAutomations ? (
                <Link className="font-medium underline" to={data.settingsPath}>
                  Open automation settings
                </Link>
              ) : (
                "Ask an administrator to turn it on."
              )}
            </Callout>
          ) : null}

          {hasPhaseModel && !stageBundlesEnabled ? (
            <Callout tone="warning" title="Administrator-run phase bundles are turned off">
              Pinned phase bundles cannot be executed until administrator-run phase bundles are enabled.{" "}
              {data.canManageAutomations ? (
                <Link className="font-medium underline" to={data.settingsPath}>
                  Open automation settings
                </Link>
              ) : (
                "Ask an administrator to turn them on."
              )}
            </Callout>
          ) : null}

          <p className="text-sm text-muted">
            Workflow {data.workflowKey} (version {data.workflowVersionNumber}
            {data.workflowFormat ? `, format ${data.workflowFormat}` : ""})
          </p>

          {hasPhaseModel ? (
            <PhaseBundlesList
              orderId={orderId}
              stages={stages}
              workflowFormat={data.workflowFormat}
              stageBundlesEnabled={stageBundlesEnabled}
              canRunBundles={canRunBundles}
              canLinkProduction={canLinkProduction}
              canLinkWebhooks={canLinkWebhooks}
              scopedStageKey={stageKey}
              onPreviewBundle={(stage) =>
                setPendingBundle({
                  stageKey: stage.stageKey,
                  stageLabel: stage.staffLabel,
                  idempotencyKey: newBundleIdempotencyKey(),
                })
              }
            />
          ) : null}

          {(!stageKey || steps.length > 0) ? (
            <div className="min-w-0 space-y-2">
              {hasPhaseModel ? (
                <h3 className="text-base font-semibold text-ink">Bound workflow step rules</h3>
              ) : null}
              {steps.length === 0 ? (
                <EmptyState
                  headingLevel={3}
                  icon={Workflow}
                  title="No workflow steps"
                  description="This order's workflow has no steps."
                />
              ) : (
                <ol className="divide-y divide-line rounded-lg border border-line" aria-label="Workflow steps">
                  {steps.map((step) => (
                    <li
                      key={step.stepKey}
                      className="flex min-w-0 flex-col gap-3 p-3 sm:flex-row sm:items-start sm:justify-between"
                      aria-current={step.isCurrentOrderStep ? "step" : undefined}
                    >
                      <div className="min-w-0 space-y-1">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                          <span className="break-words">{step.label}</span>
                          {step.isCurrentOrderStep ? (
                            <Badge tone="info" icon={<CheckCircle2 aria-hidden="true" className="size-3.5" />}>
                              Current step
                            </Badge>
                          ) : null}
                        </p>
                        <p className="text-xs text-muted">
                          {step.configuredActionCount} configured action{step.configuredActionCount === 1 ? "" : "s"} in{" "}
                          {step.configuredAutomationCount} automation{step.configuredAutomationCount === 1 ? "" : "s"}
                        </p>
                        {step.automations.length ? (
                          <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">
                            {step.automations.map((automation) => (
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
                        disabled={!data.engineEnabled || step.configuredAutomationCount === 0}
                        aria-label={`Run actions for ${step.label}`}
                        onClick={() => setPendingStep({ step, key: newStepIdempotencyKey() })}
                      >
                        Run actions
                      </Button>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          ) : null}

          {hasPhaseModel ? (
            <>
              <CompletionJobsSection
                orderId={orderId}
                stageKey={stageKey}
                stageLabelsByKey={stageLabelsByKey}
                initialJobs={data.recentCompletionJobs ?? []}
                canCancel={canCancelJobs}
                onRequestCancel={(job) => setPendingCancelJob(job)}
              />
              <PhaseBundleRunsSection
                orderId={orderId}
                stageKey={stageKey}
                initialRuns={data.recentStageRuns ?? []}
              />
            </>
          ) : null}

          {!stageKey ? <RecentRuns orderId={orderId} /> : null}
        </div>
      )}

      <RunConfirm orderId={orderId} pending={pendingStep} onClose={() => setPendingStep(null)} />
      <PhaseBundlePreviewDialog
        orderId={orderId}
        pending={pendingBundle}
        canLinkProduction={canLinkProduction}
        canLinkWebhooks={canLinkWebhooks}
        onRunCompleted={(result, announcement) => {
          setLatestRunResult(result);
          setLatestRunAnnouncement(announcement);
        }}
        onClose={() => setPendingBundle(null)}
      />
      <CancelCompletionJobDialog
        job={pendingCancelJob}
        onClose={() => setPendingCancelJob(null)}
      />
    </Section>
  );
}

/* ------------------------------------------------------------------ Pinned phase bundles (D5) */

function PhaseBundlesList({
  orderId,
  stages,
  workflowFormat,
  stageBundlesEnabled,
  canRunBundles,
  canLinkProduction,
  canLinkWebhooks,
  scopedStageKey,
  onPreviewBundle,
}: {
  orderId: string;
  stages: readonly OrderPhaseBundleView[];
  workflowFormat?: 1 | 2 | 3;
  stageBundlesEnabled: boolean;
  canRunBundles: boolean;
  canLinkProduction: boolean;
  canLinkWebhooks: boolean;
  scopedStageKey?: string;
  onPreviewBundle: (stage: OrderPhaseBundleView) => void;
}) {
  if (stages.length === 0) {
    return (
      <EmptyState
        headingLevel={3}
        icon={Workflow}
        title={scopedStageKey ? "No phase bundle for this phase" : "No pinned phases"}
        description={
          workflowFormat && workflowFormat < 3
            ? "This order uses an earlier workflow format without phase action bundles. Existing orders are never re-pinned automatically."
            : "No administrator-run phase bundles are configured on this workflow version."
        }
      />
    );
  }

  return (
    <section aria-labelledby={`phase-bundles-${orderId}`} className="min-w-0 space-y-2">
      <div className="space-y-0.5">
        <h3 id={`phase-bundles-${orderId}`} className="text-base font-semibold text-ink">
          Pinned phase action bundles
        </h3>
        <p className="text-xs text-muted">
          Configured on this order&apos;s pinned workflow version. Preview every slot before confirming execution.
        </p>
      </div>
      <ol className="divide-y divide-line rounded-lg border border-line" aria-label="Pinned workflow phases">
        {stages.map((stage) => {
          const lastRunSummary = stage.lastStageRun ? summarizeStageRun(stage.lastStageRun) : null;
          return (
            <li
              key={stage.stageKey}
              className="flex min-w-0 flex-col gap-3 p-3.5 sm:flex-row sm:items-start sm:justify-between"
              aria-current={stage.isCurrentStage ? "step" : undefined}
            >
              <div className="min-w-0 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-ink break-words">{stage.staffLabel}</span>
                  {stage.customerLabel !== stage.staffLabel ? (
                    <span className="text-xs text-muted">(Customer sees &ldquo;{stage.customerLabel}&rdquo;)</span>
                  ) : null}
                  {stage.isCurrentStage ? (
                    <Badge tone="info" icon={<CheckCircle2 aria-hidden="true" className="size-3.5" />}>
                      Current phase
                    </Badge>
                  ) : null}
                  <Badge tone={stage.configuredSlotCount > 0 ? "info" : "neutral"}>
                    {stage.configuredSlotCount} configured
                  </Badge>
                </div>

                {stage.slots.length > 0 ? (
                  <ul className="list-disc space-y-1 pl-5 text-xs text-ink">
                    {stage.slots.map((slot) => (
                      <li key={slot.slot} className="break-words">
                        <span className="font-medium">{slot.label}:</span> {slot.summary}
                        {slot.warning ? (
                          <span className="mt-0.5 flex items-start gap-1 text-ink">
                            <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warning" />
                            <span>
                              <span className="font-semibold">Warning:</span>{" "}
                              <IntegrationLinkedText
                                text={slot.warning}
                                canLinkProduction={canLinkProduction}
                                canLinkWebhooks={canLinkWebhooks}
                              />
                            </span>
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted">Nothing runs for this phase.</p>
                )}

                {stage.activeCompletionJob ? (
                  <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    <Clock aria-hidden="true" className="size-3.5 text-info" />
                    <span>
                      Scheduled completion: <strong className="text-ink">{stage.activeCompletionJob.resolvedPercent}%</strong>{" "}
                      due <DateTime value={stage.activeCompletionJob.dueAt} />
                    </span>
                  </p>
                ) : null}

                {stage.lastStageRun && lastRunSummary ? (
                  <div className="space-y-1 pt-0.5">
                    <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
                      <span>Last phase run:</span>
                      <StageRunStateBadge state={stage.lastStageRun.state} />
                      <Badge
                        tone={
                          lastRunSummary.failedCount > 0
                            ? "danger"
                            : lastRunSummary.skippedCount > 0
                              ? "warning"
                              : "neutral"
                        }
                      >
                        {lastRunSummary.dotCounts}
                      </Badge>
                      <DateTime value={stage.lastStageRun.finishedAt} format="relative" />
                    </p>
                    {lastRunSummary.notableResults.length > 0 ? (
                      <ul
                        className="space-y-1 text-xs"
                        aria-label="Skipped or failed actions in last phase run"
                      >
                        {lastRunSummary.notableResults.map((slotResult) => {
                          const isFailed = slotResult.outcome === "failed";
                          const summaryLine = firstLine(slotResult.safeSummary);
                          const needsProdLink =
                            slotResult.slot === "webhook" &&
                            /production webhook/i.test(summaryLine) &&
                            !/Integrations/i.test(summaryLine);
                          return (
                            <li key={slotResult.slot} className="flex items-start gap-1.5 text-ink">
                              {isFailed ? (
                                <XCircle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-danger" />
                              ) : (
                                <AlertTriangle
                                  aria-hidden="true"
                                  className="mt-0.5 size-3.5 shrink-0 text-warning"
                                />
                              )}
                              <span className="break-words">
                                <span className="font-semibold">
                                  {isFailed ? "Failed" : "Skipped"} ({slotFriendlyLabel(slotResult.slot)}):
                                </span>{" "}
                                <IntegrationLinkedText
                                  text={summaryLine}
                                  canLinkProduction={canLinkProduction}
                                  canLinkWebhooks={canLinkWebhooks}
                                />
                                {needsProdLink ? (
                                  <>
                                    {" ("}
                                    <IntegrationLinkedText
                                      text="Integrations → Production webhooks"
                                      canLinkProduction={canLinkProduction}
                                      canLinkWebhooks={canLinkWebhooks}
                                    />
                                    {")"}
                                  </>
                                ) : null}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <Button
                variant="secondary"
                leadingIcon={<Eye aria-hidden="true" className="size-4" />}
                className="shrink-0"
                disabled={!stageBundlesEnabled || !canRunBundles || !stage.hasConfiguredBundle}
                aria-label={`Preview and run ${stage.staffLabel}`}
                onClick={() => onPreviewBundle(stage)}
              >
                Preview and run
              </Button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/* ------------------------------------------------------------------ Preview & Confirm Dialog */

function PhaseBundlePreviewDialog({
  orderId,
  pending,
  canLinkProduction,
  canLinkWebhooks,
  onRunCompleted,
  onClose,
}: {
  orderId: string;
  pending: PendingBundleState | null;
  canLinkProduction: boolean;
  canLinkWebhooks: boolean;
  onRunCompleted: (result: RunOrderStageBundleResult, announcement: string) => void;
  onClose: () => void;
}) {
  const api = useAutomationsApi();
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const toast = useToast();
  const [overrideReason, setOverrideReason] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);

  const previewQuery = useQuery({
    ...api.orderStageActions.previewBundle.queryOptions({
      orderPublicId: orderId,
      stageKey: pending?.stageKey ?? "",
    }),
    enabled: pending !== null,
  });
  const runBundle = useMutation(api.orderStageActions.runBundle.mutationOptions());

  const preview = previewQuery.data;
  const needsOverrideReason = Boolean(preview?.requiresAdminOverrideReason);
  const overrideValid = !needsOverrideReason || overrideReason.trim().length >= 3;
  const canConfirm =
    Boolean(pending) &&
    !previewQuery.isPending &&
    !previewQuery.isError &&
    Boolean(preview?.canExecute) &&
    overrideValid &&
    !runBundle.isPending;

  const willSkipCount = preview
    ? preview.slots.filter((slot) => slotWillBeSkipped(slot, preview.statusTransition)).length
    : 0;

  const handleClose = () => {
    setOverrideReason("");
    setSubmitError(null);
    onClose();
  };

  const handleConfirm = async () => {
    if (!pending || !preview) return;
    setSubmitError(null);
    try {
      const result = await stepUp.run(
        () =>
          runBundle.mutateAsync({
            orderPublicId: orderId,
            stageKey: pending.stageKey,
            idempotencyKey: pending.idempotencyKey,
            confirmationToken: preview.confirmationToken ?? "",
            ...(needsOverrideReason ? { statusOverrideReason: overrideReason.trim() } : {}),
          }),
        { reason: `Running phase actions for "${pending.stageLabel}" requires a fresh confirmation.` },
      );

      const summary = summarizeStageRun(result.stageRun);
      const tone = summary.hasWarningOrFailure ? "warning" : "success";
      const title = result.deduplicated
        ? `Phase actions already run: ${summary.commaCounts}`
        : `Phase actions run: ${summary.commaCounts}`;
      const firstReason = summary.notableResults[0]
        ? normalizeIntegrationNoticeText(firstLine(summary.notableResults[0].safeSummary))
        : null;
      const description = result.deduplicated
        ? "This confirmation was already processed and was not repeated."
        : firstReason
          ? summary.notableResults.length > 1
            ? `${firstReason} (+${summary.notableResults.length - 1} more)`
            : firstReason
          : result.completionJob
            ? `Scheduled ${result.completionJob.resolvedPercent}% completion update.`
            : pending.stageLabel;

      toast.show({
        tone,
        title,
        description,
        duration: summary.hasWarningOrFailure ? 8000 : 5000,
      });
      onRunCompleted(result, `${title} (${pending.stageLabel}). ${description}`);
      await Promise.all([
        queryClient.invalidateQueries(api.orderStageActions.pathFilter()),
        queryClient.invalidateQueries({
          predicate: (query) => Array.isArray(query.queryKey[0]) && query.queryKey[0][0] === "orders",
        }),
      ]);
      handleClose();
    } catch (error) {
      if (error instanceof StepUpCancelledError) return;
      const safe = safeError(error);
      if (safe?.reasonCode === "STALE_STAGE_CONFIRMATION") {
        await previewQuery.refetch();
        setSubmitError(
          "The order changed since this preview loaded. Review the refreshed preview below and confirm again.",
        );
        return;
      }
      setSubmitError(errorMessage(error, "Phase actions could not be run."));
    }
  };

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
      title={pending ? `Preview phase actions: ${pending.stageLabel}` : "Preview phase actions"}
      description="Review each configured action against the order's live state before confirming execution."
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          {willSkipCount > 0 ? (
            <p className="flex items-center gap-1.5 text-xs font-medium text-ink">
              <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-warning" />
              <span>
                {willSkipCount} {willSkipCount === 1 ? "action" : "actions"} will be skipped
              </span>
            </p>
          ) : (
            <span />
          )}
          <div className="ml-auto flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={handleClose} disabled={runBundle.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={runBundle.isPending}
              disabled={!canConfirm}
              onClick={() => void handleConfirm()}
            >
              Confirm and run phase
            </Button>
          </div>
        </div>
      }
    >
      {previewQuery.isPending ? (
        <Skeleton className="h-32" />
      ) : previewQuery.isError ? (
        <ErrorState
          title="Phase preview could not be loaded"
          error={previewQuery.error}
          onRetry={() => previewQuery.refetch()}
        />
      ) : preview ? (
        <div className="space-y-4">
          {submitError ? (
            <Callout tone="danger" title="Phase actions were not run" live="assertive">
              {submitError}
            </Callout>
          ) : null}

          {!preview.canExecute && preview.blockedReason ? (
            <Callout tone="warning" title="This phase bundle cannot run right now">
              {preview.blockedReason}
            </Callout>
          ) : null}

          {preview.statusTransition && !preview.statusTransition.alreadyInTargetStatus ? (
            <Callout
              tone="warning"
              title={`Order status will change to "${preview.statusTransition.targetStatusLabel}"`}
            >
              Confirming this phase run moves order {preview.orderReference} from{" "}
              <code>{preview.currentStatusKey}</code> to{" "}
              <code>{preview.statusTransition.targetStatusKey}</code>.
              {preview.statusTransition.requiresAdminOverride
                ? " Because this is not a standard workflow step transition, an administrator override reason is required."
                : ""}
            </Callout>
          ) : null}

          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-ink">Actions in this bundle</h3>
            <ul className="divide-y divide-line overflow-hidden rounded-[var(--radius-card)] border border-line text-sm">
              {preview.slots.map((slot) => {
                const hasWarning = Boolean(slot.warning);
                return (
                  <li
                    key={slot.slot}
                    className={
                      hasWarning
                        ? "space-y-1.5 bg-warning-soft p-3 text-ink rp-forced-border"
                        : "space-y-1 p-3"
                    }
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-ink">{slot.label}</span>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {hasWarning ? (
                          <Badge
                            tone="warning"
                            icon={<AlertTriangle aria-hidden="true" className="size-3.5" />}
                          >
                            Warning
                          </Badge>
                        ) : null}
                        <Badge tone="neutral">{slot.slot.replace(/_/g, " ")}</Badge>
                      </div>
                    </div>
                    <p className={hasWarning ? "text-sm text-ink break-words" : "text-sm text-muted break-words"}>
                      {slot.summary}
                    </p>
                    {slot.warning ? (
                      <p className="flex items-start gap-1.5 text-xs font-medium text-ink">
                        <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warning" />
                        <span>
                          <span className="font-semibold">Warning:</span>{" "}
                          <IntegrationLinkedText
                            text={slot.warning}
                            canLinkProduction={canLinkProduction}
                            canLinkWebhooks={canLinkWebhooks}
                            onNavigate={handleClose}
                          />
                        </span>
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>

          {needsOverrideReason ? (
            <Field
              label="Administrator status override reason"
              required
              hint="Recorded in the durable audit log (at least 3 characters)."
            >
              <Textarea
                rows={2}
                maxLength={500}
                value={overrideReason}
                onChange={(event) => setOverrideReason(event.currentTarget.value)}
              />
            </Field>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ Completion Jobs & Cancel */

function CompletionJobsSection({
  orderId,
  stageKey,
  stageLabelsByKey,
  initialJobs,
  canCancel,
  onRequestCancel,
}: {
  orderId: string;
  stageKey?: string;
  stageLabelsByKey: ReadonlyMap<string, string>;
  initialJobs: readonly OrderCompletionJobView[];
  canCancel: boolean;
  onRequestCancel: (job: OrderCompletionJobView) => void;
}) {
  const api = useAutomationsApi();
  const [paginate, setPaginate] = useState(false);

  const queryInput = {
    orderPublicId: orderId,
    ...(stageKey ? { stageKey } : {}),
    limit: 10,
  };
  const paged = useInfiniteQuery({
    ...api.orderStageActions.listCompletionJobs.infiniteQueryOptions(queryInput, {
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
    enabled: paginate,
  });

  const scopedInitial = stageKey ? initialJobs.filter((j) => j.stageKey === stageKey) : initialJobs;
  const jobs: readonly OrderCompletionJobView[] = paginate && paged.data
    ? paged.data.pages.flatMap((page) => page.items)
    : scopedInitial;

  return (
    <section aria-labelledby={`completion-jobs-${orderId}`} className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`completion-jobs-${orderId}`} className="text-base font-semibold text-ink">
          Completion percentage updates
        </h3>
        {!paginate && scopedInitial.length >= 10 ? (
          <Button size="sm" variant="ghost" onClick={() => setPaginate(true)}>
            Browse full history
          </Button>
        ) : null}
      </div>

      {paginate && paged.isPending ? (
        <Skeleton className="h-20" />
      ) : paginate && paged.isError ? (
        <ErrorState
          title="Completion updates could not be loaded"
          error={paged.error}
          onRetry={() => paged.refetch()}
        />
      ) : jobs.length === 0 ? (
        <p className="text-sm text-muted">No scheduled or completed percentage updates for this order yet.</p>
      ) : (
        <>
          <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Completion percentage jobs">
            {jobs.map((job) => (
              <li
                key={job.publicId}
                className="flex min-w-0 flex-col gap-2 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-ink">{job.resolvedPercent}% completion</span>
                    <CompletionJobStateBadge state={job.state} />
                    <Badge tone="neutral">
                      {job.policyKind === "range"
                        ? `Range ${job.minPercent}%–${job.maxPercent}%`
                        : "Fixed"}
                    </Badge>
                    {job.stageKey ? (
                      <Badge tone="neutral">
                        Phase: {stageLabelsByKey.get(job.stageKey) ?? job.stageKey}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted">
                    {job.state === "scheduled" ? (
                      <>
                        Due <DateTime value={job.dueAt} />
                      </>
                    ) : job.completedAt ? (
                      <>
                        Applied <DateTime value={job.completedAt} />
                      </>
                    ) : job.canceledAt ? (
                      <>
                        Canceled <DateTime value={job.canceledAt} />
                        {job.canceledBy ? ` by ${job.canceledBy.displayName}` : ""}
                      </>
                    ) : (
                      <>
                        Scheduled for <DateTime value={job.dueAt} />
                      </>
                    )}
                    {" · "}
                    {job.sourceKind === "stage_run" ? "From phase bundle" : "From automation rule"}
                    {job.reasonCode ? ` · ${job.reasonCode}` : ""}
                  </p>
                </div>

                {job.state === "scheduled" && canCancel ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    leadingIcon={<XCircle aria-hidden="true" className="size-4" />}
                    className="shrink-0"
                    aria-label={`Cancel ${job.resolvedPercent}% completion update`}
                    onClick={() => onRequestCancel(job)}
                  >
                    Cancel
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          {paginate ? (
            <LoadMore
              hasMore={Boolean(paged.hasNextPage)}
              loading={paged.isFetchingNextPage}
              onLoadMore={() => paged.fetchNextPage()}
              summary={`Showing ${jobs.length} completion update${jobs.length === 1 ? "" : "s"}`}
              label="Load more completion updates"
            />
          ) : null}
        </>
      )}
    </section>
  );
}

function CancelCompletionJobDialog({
  job,
  onClose,
}: {
  job: OrderCompletionJobView | null;
  onClose: () => void;
}) {
  const api = useAutomationsApi();
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const cancelMutation = useMutation(api.orderStageActions.cancelCompletionJob.mutationOptions());

  const handleClose = () => {
    setReason("");
    onClose();
  };

  return (
    <ConfirmDialog
      open={job !== null}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
      title={job ? `Cancel ${job.resolvedPercent}% completion update?` : "Cancel completion update?"}
      description="The scheduled percentage update will be marked canceled and will not change this order's progress."
      confirmLabel="Cancel scheduled update"
      destructive
      onConfirm={async () => {
        if (!job) return;
        try {
          await stepUp.run(
            () =>
              cancelMutation.mutateAsync({
                completionJobPublicId: job.publicId,
                reason: reason.trim() || undefined,
              }),
            { reason: "Canceling a scheduled completion update requires a fresh confirmation." },
          );
          toast.show({
            tone: "success",
            title: `Canceled ${job.resolvedPercent}% completion update`,
          });
          await queryClient.invalidateQueries(api.orderStageActions.pathFilter());
          handleClose();
        } catch (error) {
          if (error instanceof StepUpCancelledError) return;
          toast.show({
            tone: "danger",
            title: "Completion update was not canceled",
            description: errorMessage(error),
          });
          throw error;
        }
      }}
    >
      <Field label="Cancellation note" hint="Optional plain-text reason recorded in audit logs.">
        <Input
          maxLength={240}
          value={reason}
          onChange={(event) => setReason(event.currentTarget.value)}
        />
      </Field>
    </ConfirmDialog>
  );
}

/* ------------------------------------------------------------------ Phase Bundle Run History */

function PhaseBundleRunsSection({
  orderId,
  stageKey,
  initialRuns,
}: {
  orderId: string;
  stageKey?: string;
  initialRuns: readonly OrderStageRunView[];
}) {
  const api = useAutomationsApi();
  const [paginate, setPaginate] = useState(false);

  const queryInput = {
    orderPublicId: orderId,
    ...(stageKey ? { stageKey } : {}),
    limit: 10,
  };
  const paged = useInfiniteQuery({
    ...api.orderStageActions.listBundleRuns.infiniteQueryOptions(queryInput, {
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
    enabled: paginate,
  });

  const scopedInitial = stageKey ? initialRuns.filter((r) => r.stageKey === stageKey) : initialRuns;
  const runs: readonly OrderStageRunView[] = paginate && paged.data
    ? paged.data.pages.flatMap((page) => page.items)
    : scopedInitial;

  return (
    <section aria-labelledby={`phase-runs-${orderId}`} className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`phase-runs-${orderId}`} className="text-base font-semibold text-ink">
          Phase bundle run history
        </h3>
        {!paginate && scopedInitial.length >= 10 ? (
          <Button size="sm" variant="ghost" onClick={() => setPaginate(true)}>
            Load full phase run history
          </Button>
        ) : null}
      </div>

      {paginate && paged.isPending ? (
        <Skeleton className="h-20" />
      ) : paginate && paged.isError ? (
        <ErrorState
          title="Phase run history could not be loaded"
          error={paged.error}
          onRetry={() => paged.refetch()}
        />
      ) : runs.length === 0 ? (
        <p className="text-sm text-muted">No phase bundles have been run for this order yet.</p>
      ) : (
        <>
          <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Phase bundle runs">
            {runs.map((run) => (
              <li key={run.publicId} className="min-w-0 space-y-2 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-ink break-words">{run.stageLabel}</span>
                  <StageRunStateBadge state={run.state} />
                  <span className="text-xs text-muted">
                    {run.triggeredBy ? `Run by ${run.triggeredBy.displayName}` : "Administrator run"} ·{" "}
                    <DateTime value={run.finishedAt} />
                  </span>
                  <code className="text-xs text-muted">{run.correlationId}</code>
                </div>
                {run.results.length > 0 ? (
                  <ul className="grid gap-1.5 pl-1 sm:grid-cols-2">
                    {run.results.map((slotResult) => (
                      <li
                        key={slotResult.slot}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-control)] border border-line bg-surface-soft px-2.5 py-1.5 text-xs"
                      >
                        <span className="min-w-0 break-words text-ink">
                          <strong className="capitalize">{slotResult.slot.replace(/_/g, " ")}:</strong>{" "}
                          {slotResult.safeSummary}
                        </span>
                        <StageSlotOutcomeBadge outcome={slotResult.outcome} />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
          {paginate ? (
            <LoadMore
              hasMore={Boolean(paged.hasNextPage)}
              loading={paged.isFetchingNextPage}
              onLoadMore={() => paged.fetchNextPage()}
              summary={`Showing ${runs.length} phase run${runs.length === 1 ? "" : "s"}`}
              label="Load more phase runs"
            />
          ) : null}
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ Bound Workflow Step Confirm & Recent Rule Runs (T2) */

/** Always mounted so the dialog can return focus to the step's trigger when it closes. */
function RunConfirm({
  orderId,
  pending,
  onClose,
}: {
  orderId: string;
  pending: { step: OrderStageStepView; key: string } | null;
  onClose: () => void;
}) {
  const api = useAutomationsApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const run = useMutation(api.orderStageActions.runForOrder.mutationOptions());
  return (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={pending ? `Run actions for ${pending.step.label}?` : "Run actions?"}
      description="The configured automations for this step are queued now, even if the order is in a different step. Repeating this request does not queue them twice."
      confirmLabel="Run actions"
      onConfirm={async () => {
        if (!pending) return;
        try {
          const result = await run.mutateAsync({
            orderPublicId: orderId,
            stepKey: pending.step.stepKey,
            idempotencyKey: pending.key,
          });
          const fresh = result.queuedRuns.filter((r) => !r.deduplicated).length;
          toast.show({
            tone: "success",
            title: `${fresh} automation run${fresh === 1 ? "" : "s"} queued`,
            description:
              fresh < result.queuedRuns.length ? "Some were already queued and were not repeated." : undefined,
          });
          await queryClient.invalidateQueries(api.orderStageActions.pathFilter());
          onClose();
        } catch (error) {
          toast.show({ tone: "danger", title: "Actions were not run", description: errorMessage(error) });
          throw error;
        }
      }}
    >
      <ul className="list-disc space-y-0.5 pl-5 text-sm">
        {pending?.step.automations.map((automation) => (
          <li key={automation.publicId} className="break-words">
            {automation.name}
          </li>
        ))}
      </ul>
    </ConfirmDialog>
  );
}

function RecentRuns({ orderId }: { orderId: string }) {
  const api = useAutomationsApi();
  const list = useInfiniteQuery(
    api.orderStageActions.listRuns.infiniteQueryOptions(
      { orderPublicId: orderId, limit: 10 },
      { getNextPageParam: (page) => page.nextCursor ?? undefined },
    ),
  );
  const runs: AutomationRunView[] = list.data?.pages.flatMap((page): AutomationRunView[] => page.items) ?? [];
  return (
    <section aria-labelledby={`runs-${orderId}`} className="min-w-0 space-y-2">
      <h3 id={`runs-${orderId}`} className="text-base font-semibold text-ink">
        Recent runs for this order
      </h3>
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
                  {run.triggeredBy
                    ? `Run by ${run.triggeredBy.displayName}`
                    : run.triggerKey
                      ? `Triggered by ${run.triggerKey}`
                      : "Triggered automatically"}{" "}
                  · <DateTime value={run.queuedAt} />
                  {run.reasonCode ? ` · ${run.reasonCode}` : ""}
                </span>
              </li>
            ))}
          </ul>
          <LoadMore
            hasMore={Boolean(list.hasNextPage)}
            loading={list.isFetchingNextPage}
            onLoadMore={() => list.fetchNextPage()}
            summary={`Showing ${runs.length} run${runs.length === 1 ? "" : "s"}`}
            label="Load more runs"
          />
        </>
      )}
    </section>
  );
}
