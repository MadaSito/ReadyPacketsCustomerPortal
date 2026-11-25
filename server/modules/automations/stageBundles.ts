/**
 * Increment 07 (D5): Human-initiated 5-slot phase action bundle preview, execution,
 * idempotent `order_stage_runs` persistence, and per-order history.
 */
import { timingSafeEqual } from "node:crypto";
import { and, desc, eq, lt } from "drizzle-orm";
import { roleHasCapability } from "../../../shared/capabilities.js";
import {
  stageActionsSchema,
  type StageActions,
  type WorkflowStage,
} from "../../../shared/workflowStages.js";
import type { ModuleDeps } from "../../container.js";
import { conflict, DomainError, forbidden, notFound, validation } from "../../core/errors.js";
import { ULID_PATTERN, ulid } from "../../core/ids.js";
import type { Db, FieldCrypto, SessionPrincipal, Tx } from "../../core/types.js";
import { automationCorrelationId } from "../audit/tap.js";
import { lockBlocks, orderLocked } from "../orders/policy.js";
import { orders } from "../orders/schema.js";
import type { BoundWorkflow } from "../orders/workflows.js";
import { readSetting } from "../platform/index.js";
import {
  assertAutomationsActorInTx,
  assertAutomationsCapabilityPreflight,
  recordAutomationsDenied,
} from "./authz.js";
import {
  admitOrderCompletionInTx,
  hydrateCompletionJobViews,
  loadActorViewsById,
  sanitizeOpsAlertCopy,
} from "./completionJobs.js";
import type {
  OrderCompletionJobView,
  OrderPhaseBundleStatusTransitionView,
  OrderPhaseBundleView,
  OrderStageBundlePreviewView,
  OrderStageRunActorView,
  OrderStageRunState,
  OrderStageRunView,
  RunOrderStageBundleResult,
  StageBundleSlotPreview,
  StageBundleSlotResult,
} from "./contracts.js";
import { orderCompletionJobs, orderStageRuns } from "./schema.js";
import { AUTOMATIONS_CONFIG } from "./settings.js";

const STAGE_KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
const BUNDLE_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9:_-]{8,64}$/;
const CONFIRMATION_TOKEN_RE = /^[0-9a-f]{64}$/;

export function computeStageConfirmationToken(
  fieldCrypto: FieldCrypto,
  input: {
    actorUserId: number;
    sessionId: string;
    orderPublicId: string;
    workflowVersionId: number;
    stageKey: string;
    orderVersion: number;
    statusKey: string;
    lockState: string;
    ownerUserId: number;
    completionRevision: number;
    bundle: StageActions;
    slots: readonly StageBundleSlotPreview[];
  },
): string {
  const canonical = JSON.stringify({
    v: 1,
    actorUserId: input.actorUserId,
    sessionId: input.sessionId,
    orderPublicId: input.orderPublicId,
    workflowVersionId: input.workflowVersionId,
    stageKey: input.stageKey,
    orderVersion: input.orderVersion,
    statusKey: input.statusKey,
    lockState: input.lockState,
    ownerUserId: input.ownerUserId,
    completionRevision: input.completionRevision,
    bundle: input.bundle,
    slots: input.slots.map((s) => ({
      slot: s.slot,
      summary: s.summary,
      warning: s.warning,
    })),
  });
  return fieldCrypto.blindIndex(canonical, "automations.stage_confirmation");
}

export const STAGE_BUNDLES_DISABLED_MESSAGE =
  "Workflow phase action bundles are currently disabled in Automations settings.";

interface PersistedBundleSnapshot {
  bundle: StageActions;
  statusOverrideReason: string | null;
}

function parseJsonSafe<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function countConfiguredBundleSlots(bundle: StageActions | null | undefined): number {
  if (!bundle) return 0;
  let count = 0;
  if (bundle.setStatusKey) count += 1;
  if (bundle.completion) count += 1;
  if (bundle.emailTemplateKey) count += 1;
  if (bundle.webhookTargetKey) count += 1;
  if (bundle.dashboardAlert) count += 1;
  return count;
}

export function hasConfiguredStageBundle(bundle: StageActions | null | undefined): boolean {
  return countConfiguredBundleSlots(bundle) > 0;
}

export function computeStatusTransitionPreview(
  currentStatusKey: string,
  targetStatusKey: string,
  bound: BoundWorkflow,
): OrderPhaseBundleStatusTransitionView {
  const targetState = bound.definition.states.find((s) => s.key === targetStatusKey);
  const targetStatusLabel = targetState?.label ?? targetStatusKey;
  const alreadyInTargetStatus = currentStatusKey === targetStatusKey;
  const isAllowedStandardTransition =
    alreadyInTargetStatus ||
    bound.definition.transitions.some(
      (t) => t.from === currentStatusKey && t.to === targetStatusKey,
    );
  return {
    targetStatusKey,
    targetStatusLabel,
    alreadyInTargetStatus,
    isAllowedStandardTransition,
    requiresAdminOverride: !alreadyInTargetStatus && !isAllowedStandardTransition,
  };
}

export async function buildStageSlotPreviews(
  deps: ModuleDeps,
  handle: Db | Tx,
  bundle: StageActions,
  currentStatusKey: string,
  bound: BoundWorkflow,
): Promise<{
  slots: StageBundleSlotPreview[];
  statusTransition: OrderPhaseBundleStatusTransitionView | null;
}> {
  const slots: StageBundleSlotPreview[] = [];
  let statusTransition: OrderPhaseBundleStatusTransitionView | null = null;

  if (bundle.setStatusKey) {
    statusTransition = computeStatusTransitionPreview(
      currentStatusKey,
      bundle.setStatusKey,
      bound,
    );
    const targetExists = bound.definition.states.some((s) => s.key === bundle.setStatusKey);
    slots.push({
      slot: "status",
      label: "Set order status",
      summary: statusTransition.alreadyInTargetStatus
        ? `Order is already in "${statusTransition.targetStatusLabel}" (will skip)`
        : `Transition status to "${statusTransition.targetStatusLabel}"`,
      warning: !targetExists
        ? `Status "${bundle.setStatusKey}" is not present on this order's pinned workflow version.`
        : statusTransition.requiresAdminOverride
          ? "Outside standard workflow transitions; requires administrator role and override reason."
          : null,
    });
  }

  if (bundle.completion) {
    const delayMin = bundle.completion.delayMinutes ?? 0;
    const pctDesc =
      bundle.completion.kind === "fixed"
        ? `${bundle.completion.percent}%`
        : `${bundle.completion.min}%–${bundle.completion.max}% (single server draw)`;
    slots.push({
      slot: "completion",
      label: "Update completion percentage",
      summary:
        delayMin > 0
          ? `Schedule completion update to ${pctDesc} in ${delayMin} minute${delayMin === 1 ? "" : "s"}`
          : `Set completion percentage to ${pctDesc} immediately`,
      warning: null,
    });
  }

  if (bundle.emailTemplateKey) {
    const resolved = deps.services.mailTemplates?.resolveForPhaseAction
      ? await deps.services.mailTemplates.resolveForPhaseAction(
          bundle.emailTemplateKey,
          handle as Tx,
        )
      : null;
    slots.push({
      slot: "email",
      label: "Send customer email",
      summary: resolved
        ? `Send template "${resolved.key}" to order customer`
        : `Send template "${bundle.emailTemplateKey}" to order customer`,
      warning: resolved
        ? null
        : `Template "${bundle.emailTemplateKey}" is not currently published or uses unsupported variables.`,
    });
  }

  if (bundle.webhookTargetKey) {
    const check = deps.services.integrations?.workflowWebhooks?.validateTargetKey
      ? await deps.services.integrations.workflowWebhooks.validateTargetKey(
          bundle.webhookTargetKey,
          handle,
        )
      : null;
    slots.push({
      slot: "webhook",
      label: "Enqueue workflow webhook",
      summary: `Enqueue signed webhook delivery to "${bundle.webhookTargetKey}"`,
      warning:
        check && (!check.valid || !check.configured || !check.enabled) ? check.message : null,
    });
  }

  if (bundle.dashboardAlert) {
    slots.push({
      slot: "dashboard_alert",
      label: "Create operational alert",
      summary: `[${bundle.dashboardAlert.severity.toUpperCase()}] ${bundle.dashboardAlert.text}`,
      warning: null,
    });
  }

  return { slots, statusTransition };
}

export function stageRunRowToView(
  row: typeof orderStageRuns.$inferSelect,
  actors: ReadonlyMap<number, OrderStageRunActorView>,
): OrderStageRunView {
  const parsedSnapshot = parseJsonSafe<PersistedBundleSnapshot | StageActions>(
    row.bundleSnapshotJson,
    {},
  );
  const bundle: StageActions =
    parsedSnapshot && typeof parsedSnapshot === "object" && "bundle" in parsedSnapshot
      ? parsedSnapshot.bundle
      : (parsedSnapshot as StageActions);
  const statusOverrideReason =
    parsedSnapshot && typeof parsedSnapshot === "object" && "statusOverrideReason" in parsedSnapshot
      ? (parsedSnapshot.statusOverrideReason ?? null)
      : null;
  const results = parseJsonSafe<StageBundleSlotResult[]>(row.resultsJson, []);

  return {
    publicId: row.publicId,
    orderPublicId: row.orderPublicId,
    stageKey: row.stageKey,
    stageLabel: row.stageLabel,
    state: row.state,
    reasonCode: row.reasonCode,
    triggeredBy: row.triggeredByUserId ? (actors.get(row.triggeredByUserId) ?? null) : null,
    correlationId: row.correlationId,
    bundle,
    statusOverrideReason,
    results,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}

export async function hydrateStageRunViews(
  handle: Db | Tx,
  crypto: FieldCrypto,
  rows: readonly (typeof orderStageRuns.$inferSelect)[],
): Promise<OrderStageRunView[]> {
  if (rows.length === 0) return [];
  const actors = await loadActorViewsById(
    handle,
    crypto,
    rows.map((r) => r.triggeredByUserId),
  );
  return rows.map((r) => stageRunRowToView(r, actors));
}

export async function buildOrderPhaseBundleSection(
  deps: ModuleDeps,
  orderPublicId: string,
  bound: BoundWorkflow,
  runLimit: number,
): Promise<{
  currentStageKey: string | null;
  progressPercent: number;
  completionRevision: number;
  workflowFormat: 1 | 2 | 3;
  stages: OrderPhaseBundleView[];
  recentStageRuns: OrderStageRunView[];
  recentCompletionJobs: OrderCompletionJobView[];
}> {
  const stageCtx = await deps.services.orders.stages.contextForRun(orderPublicId, deps.db);
  const rawFormat = (bound.definition as { format?: number }).format;
  const workflowFormat: 1 | 2 | 3 =
    rawFormat === 3 || stageCtx.stages.length > 0 ? 3 : rawFormat === 2 ? 2 : 1;

  const recentRunRows = await deps.db
    .select()
    .from(orderStageRuns)
    .where(eq(orderStageRuns.orderId, stageCtx.orderId))
    .orderBy(desc(orderStageRuns.id))
    .limit(runLimit);
  const recentStageRuns = await hydrateStageRunViews(deps.db, deps.crypto, recentRunRows);

  const recentJobRows = await deps.db
    .select()
    .from(orderCompletionJobs)
    .where(eq(orderCompletionJobs.orderId, stageCtx.orderId))
    .orderBy(desc(orderCompletionJobs.id))
    .limit(runLimit);
  const recentCompletionJobs = await hydrateCompletionJobViews(deps.db, deps.crypto, recentJobRows);

  const activeJobsRows = await deps.db
    .select()
    .from(orderCompletionJobs)
    .where(
      and(
        eq(orderCompletionJobs.orderId, stageCtx.orderId),
        eq(orderCompletionJobs.state, "scheduled"),
      ),
    )
    .orderBy(desc(orderCompletionJobs.id));
  const activeJobViews = await hydrateCompletionJobViews(deps.db, deps.crypto, activeJobsRows);
  const activeByStage = new Map<string, OrderCompletionJobView>();
  for (const jv of activeJobViews) {
    if (jv.stageKey && !activeByStage.has(jv.stageKey)) {
      activeByStage.set(jv.stageKey, jv);
    }
  }

  const lastRunByStage = new Map<string, OrderStageRunView>();
  for (const rv of recentStageRuns) {
    if (!lastRunByStage.has(rv.stageKey)) {
      lastRunByStage.set(rv.stageKey, rv);
    }
  }

  const stages: OrderPhaseBundleView[] = [];
  for (const st of stageCtx.stages) {
    const parsedBundle = st.stageActions ? stageActionsSchema.safeParse(st.stageActions) : null;
    const bundle = parsedBundle?.success ? parsedBundle.data : null;
    const configuredCount = countConfiguredBundleSlots(bundle);
    const hasBundle = configuredCount > 0;
    const preview =
      bundle && hasBundle
        ? await buildStageSlotPreviews(deps, deps.db, bundle, stageCtx.statusKey, bound)
        : { slots: [], statusTransition: null };

    stages.push({
      stageKey: st.key,
      customerLabel: st.customerLabel,
      staffLabel: st.staffLabel,
      statusKeys: st.statusKeys,
      isCurrentStage: stageCtx.currentStageKey === st.key,
      hasConfiguredBundle: hasBundle,
      configuredSlotCount: configuredCount,
      bundle: hasBundle ? bundle : null,
      slots: preview.slots,
      statusTransition: preview.statusTransition,
      activeCompletionJob: activeByStage.get(st.key) ?? null,
      lastStageRun: lastRunByStage.get(st.key) ?? null,
    });
  }

  return {
    currentStageKey: stageCtx.currentStageKey,
    progressPercent: stageCtx.progressPercent,
    completionRevision: stageCtx.completionRevision,
    workflowFormat,
    stages,
    recentStageRuns,
    recentCompletionJobs,
  };
}

export async function previewOrderStageBundle(
  deps: ModuleDeps,
  principal: SessionPrincipal,
  input: { orderPublicId: string; stageKey: string },
): Promise<OrderStageBundlePreviewView> {
  if (!ULID_PATTERN.test(input.orderPublicId)) {
    throw validation("INVALID_ORDER_ID", "Order identifier is invalid.");
  }
  const stageKey = input.stageKey.trim();
  if (!STAGE_KEY_RE.test(stageKey)) {
    throw validation("INVALID_STAGE_KEY", "Workflow stage key is invalid.");
  }

  // Allow active staff/admin with orders.automations.run or orders.stage.run to preview before MFA step-up.
  await assertAutomationsCapabilityPreflight(deps, principal, "orders.automations.run");

  const ordersSvc = deps.services.orders;
  const access = await ordersSvc.assertCanReadOrder(principal, input.orderPublicId);
  const [orderRow] = await deps.db
    .select({
      id: orders.id,
      version: orders.version,
      lockState: orders.lockState,
      ownerUserId: orders.ownerUserId,
    })
    .from(orders)
    .where(eq(orders.publicId, access.publicId))
    .limit(1);
  if (!orderRow) {
    throw notFound("Order not found.");
  }

  const stageCtx = await ordersSvc.stages.contextForRun(input.orderPublicId, deps.db);
  const bound = await ordersSvc.workflows.byVersionId(deps.db, stageCtx.workflowVersionId);
  const cfg = await readSetting(deps.settings, AUTOMATIONS_CONFIG);

  const stage = stageCtx.stages.find((s) => s.key === stageKey);
  if (!stage) {
    throw notFound("WORKFLOW_STAGE_NOT_FOUND");
  }
  const parsedBundle = stage.stageActions ? stageActionsSchema.safeParse(stage.stageActions) : null;
  if (!parsedBundle?.success || !hasConfiguredStageBundle(parsedBundle.data)) {
    throw validation(
      "NO_STAGE_BUNDLE_CONFIGURED",
      `No phase action bundle is configured on stage "${stage.staffLabel}".`,
    );
  }
  const bundle = parsedBundle.data;
  const { slots, statusTransition } = await buildStageSlotPreviews(
    deps,
    deps.db,
    bundle,
    stageCtx.statusKey,
    bound,
  );

  const confirmationToken = computeStageConfirmationToken(deps.crypto, {
    actorUserId: principal.userId,
    sessionId: principal.sessionId,
    orderPublicId: access.publicId,
    workflowVersionId: stageCtx.workflowVersionId,
    stageKey: stage.key,
    orderVersion: orderRow.version,
    statusKey: stageCtx.statusKey,
    lockState: orderRow.lockState,
    ownerUserId: orderRow.ownerUserId,
    completionRevision: stageCtx.completionRevision,
    bundle,
    slots,
  });

  const requiresTransitionCapability = Boolean(bundle.setStatusKey);
  const requiresAdminOverrideReason = Boolean(statusTransition?.requiresAdminOverride);
  const writeKind = bundle.setStatusKey && !bundle.completion ? "status" : "order";
  const isLockedForBundle =
    orderRow.lockState === "legal_hold" ||
    orderRow.lockState === "imported_read_only" ||
    lockBlocks(orderRow.lockState, true, writeKind);

  let canExecute = true;
  let blockedReason: string | null = null;

  if (!cfg.stageBundlesEnabled) {
    canExecute = false;
    blockedReason = STAGE_BUNDLES_DISABLED_MESSAGE;
  } else if (isLockedForBundle) {
    canExecute = false;
    blockedReason = `Order is locked (${orderRow.lockState}) and cannot run phase action bundles.`;
  } else if (!roleHasCapability(principal.role, "orders.stage.run")) {
    canExecute = false;
    blockedReason = "Your role does not include orders.stage.run.";
  } else if (requiresTransitionCapability && !roleHasCapability(principal.role, "orders.transition")) {
    canExecute = false;
    blockedReason = "Running a bundle that changes order status requires orders.transition.";
  } else if (requiresAdminOverrideReason && principal.role !== "admin") {
    canExecute = false;
    blockedReason =
      "Target status is outside standard workflow transitions and requires an administrator override.";
  }

  return {
    orderPublicId: access.publicId,
    orderReference: access.reference,
    orderVersion: orderRow.version,
    stageKey: stage.key,
    customerLabel: stage.customerLabel,
    staffLabel: stage.staffLabel,
    currentStatusKey: stageCtx.statusKey,
    currentProgressPercent: stageCtx.progressPercent,
    completionRevision: stageCtx.completionRevision,
    confirmationToken,
    requiresStepUp: true,
    requiresTransitionCapability,
    requiresAdminOverrideReason,
    canExecute,
    blockedReason,
    bundle,
    slots,
    statusTransition,
  };
}

export async function executeOrderStageBundle(
  deps: ModuleDeps,
  principal: SessionPrincipal,
  input: {
    orderPublicId: string;
    stageKey: string;
    idempotencyKey: string;
    confirmationToken: string;
    statusOverrideReason?: string | null;
  },
): Promise<RunOrderStageBundleResult> {
  await assertAutomationsCapabilityPreflight(deps, principal, "orders.stage.run");

  if (!ULID_PATTERN.test(input.orderPublicId)) {
    throw validation("INVALID_ORDER_ID", "Order identifier is invalid.");
  }
  const stageKey = input.stageKey.trim();
  if (!STAGE_KEY_RE.test(stageKey)) {
    throw validation("INVALID_STAGE_KEY", "Workflow stage key is invalid.");
  }
  const idempotencyKey = input.idempotencyKey.trim();
  if (!BUNDLE_IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    throw validation(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency key must be 8–64 URL-safe characters.",
    );
  }
  const confirmationToken = input.confirmationToken.trim();
  if (!CONFIRMATION_TOKEN_RE.test(confirmationToken)) {
    throw validation(
      "INVALID_CONFIRMATION_TOKEN",
      "Preview confirmation token is invalid or missing.",
    );
  }
  const overrideReason = input.statusOverrideReason?.trim() ?? null;
  if (overrideReason && overrideReason.length > 500) {
    throw validation("OVERRIDE_REASON_TOO_LONG", "Override reason must be at most 500 characters.");
  }

  const ordersSvc = deps.services.orders;
  await ordersSvc.assertCanReadOrder(principal, input.orderPublicId);

  return deps.db.transaction(async (tx) => {
    const lockedActors = await assertAutomationsActorInTx(
      deps,
      principal,
      tx,
      "orders.stage.run",
    );
    const liveActor = lockedActors.get(principal.userId)!;

    const cfg = await readSetting(deps.settings, AUTOMATIONS_CONFIG, tx);
    if (!cfg.stageBundlesEnabled) {
      throw new DomainError(
        "NOT_CONFIGURED",
        "STAGE_BUNDLES_DISABLED",
        STAGE_BUNDLES_DISABLED_MESSAGE,
      );
    }

    const [lockedOrder] = await tx
      .select({
        id: orders.id,
        publicId: orders.publicId,
        reference: orders.reference,
        ownerUserId: orders.ownerUserId,
        workflowVersionId: orders.workflowVersionId,
        statusKey: orders.statusKey,
        lockState: orders.lockState,
        completionRevision: orders.completionRevision,
        version: orders.version,
      })
      .from(orders)
      .where(eq(orders.publicId, input.orderPublicId))
      .for("update");

    if (!lockedOrder) {
      throw notFound("Order not found.");
    }

    await ordersSvc.assertCanReadOrder(principal, lockedOrder.publicId, { tx });

    const [existingRun] = await tx
      .select()
      .from(orderStageRuns)
      .where(
        and(
          eq(orderStageRuns.orderId, lockedOrder.id),
          eq(orderStageRuns.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);

    if (existingRun) {
      if (existingRun.stageKey !== stageKey) {
        throw conflict(
          "IDEMPOTENCY_KEY_CONFLICT",
          "Idempotency key was already used for another stage on this order.",
        );
      }
      const [runView] = await hydrateStageRunViews(tx, deps.crypto, [existingRun]);
      const [linkedJobRow] = await tx
        .select()
        .from(orderCompletionJobs)
        .where(
          and(
            eq(orderCompletionJobs.sourceKind, "stage_run"),
            eq(orderCompletionJobs.sourcePublicId, existingRun.publicId),
          ),
        )
        .limit(1);
      const [jobView] = linkedJobRow
        ? await hydrateCompletionJobViews(tx, deps.crypto, [linkedJobRow])
        : [null];
      return {
        deduplicated: true,
        stageRun: runView!,
        completionJob: jobView ?? null,
      };
    }

    let stageCtx = await ordersSvc.stages.contextForRun(lockedOrder.publicId, tx);
    // Use current-read columns from SELECT ... FOR UPDATE rather than REPEATABLE READ snapshot values.
    stageCtx = {
      ...stageCtx,
      orderId: lockedOrder.id,
      workflowVersionId: lockedOrder.workflowVersionId,
      statusKey: lockedOrder.statusKey,
      completionRevision: lockedOrder.completionRevision,
    };
    const bound = await ordersSvc.workflows.byVersionId(tx, lockedOrder.workflowVersionId);

    const stage: WorkflowStage | undefined = stageCtx.stages.find((s) => s.key === stageKey);
    if (!stage) {
      throw notFound("WORKFLOW_STAGE_NOT_FOUND");
    }

    const parsedBundle = stage.stageActions ? stageActionsSchema.safeParse(stage.stageActions) : null;
    if (!parsedBundle?.success || !hasConfiguredStageBundle(parsedBundle.data)) {
      throw validation(
        "NO_STAGE_BUNDLE_CONFIGURED",
        `No phase action bundle is configured on stage "${stage.staffLabel}".`,
      );
    }
    const bundle = parsedBundle.data;
    const writeKind = bundle.setStatusKey && !bundle.completion ? "status" : "order";
    if (
      lockedOrder.lockState === "legal_hold" ||
      lockedOrder.lockState === "imported_read_only" ||
      lockBlocks(lockedOrder.lockState, true, writeKind)
    ) {
      throw orderLocked(lockedOrder.lockState);
    }

    const liveSlotPreviews = await buildStageSlotPreviews(
      deps,
      tx,
      bundle,
      lockedOrder.statusKey,
      bound,
    );
    const liveConfirmationToken = computeStageConfirmationToken(deps.crypto, {
      actorUserId: principal.userId,
      sessionId: principal.sessionId,
      orderPublicId: lockedOrder.publicId,
      workflowVersionId: lockedOrder.workflowVersionId,
      stageKey: stage.key,
      orderVersion: lockedOrder.version,
      statusKey: lockedOrder.statusKey,
      lockState: lockedOrder.lockState,
      ownerUserId: lockedOrder.ownerUserId,
      completionRevision: lockedOrder.completionRevision,
      bundle,
      slots: liveSlotPreviews.slots,
    });
    if (
      !timingSafeEqual(
        Buffer.from(liveConfirmationToken, "hex"),
        Buffer.from(confirmationToken, "hex"),
      )
    ) {
      throw conflict(
        "STALE_STAGE_CONFIRMATION",
        "Order state or action availability changed since preview. Review the updated preview and confirm again.",
      );
    }

    let transitionPreview: OrderPhaseBundleStatusTransitionView | null = null;
    if (bundle.setStatusKey) {
      await assertAutomationsActorInTx(deps, principal, tx, "orders.transition");
      const targetExists = bound.definition.states.some((s) => s.key === bundle.setStatusKey);
      if (!targetExists) {
        throw validation(
          "INVALID_STAGE_TARGET_STATUS",
          `Target status "${bundle.setStatusKey}" does not exist on this order's pinned workflow version.`,
        );
      }
      transitionPreview = computeStatusTransitionPreview(
        lockedOrder.statusKey,
        bundle.setStatusKey,
        bound,
      );
      if (transitionPreview.requiresAdminOverride) {
        if (liveActor.role !== "admin") {
          void recordAutomationsDenied(
            deps,
            principal,
            "orders.transition",
            "STATUS_OVERRIDE_REQUIRES_ADMIN",
          ).catch(() => undefined);
          throw forbidden("STATUS_OVERRIDE_REQUIRES_ADMIN");
        }
        if (!overrideReason || overrideReason.length < 5) {
          throw validation(
            "STATUS_OVERRIDE_REASON_REQUIRED",
            "An administrator override reason of at least 5 characters is required for this status transition.",
          );
        }
      }
    }

    const runPublicId = ulid();
    const correlationId = automationCorrelationId(runPublicId);
    const startedAt = deps.clock.now();
    const results: StageBundleSlotResult[] = [];
    let createdCompletionJobRow: typeof orderCompletionJobs.$inferSelect | null = null;

    // Slot 1: Set status
    if (bundle.setStatusKey && transitionPreview) {
      if (transitionPreview.alreadyInTargetStatus) {
        results.push({
          slot: "status",
          outcome: "skipped",
          reasonCode: "ALREADY_IN_STATUS",
          safeSummary: `Order is already in status "${transitionPreview.targetStatusLabel}".`,
          externalRef: bundle.setStatusKey,
        });
      } else {
        try {
          const applied = await ordersSvc.stages.applyStageStatus(
            {
              orderPublicId: lockedOrder.publicId,
              toStatus: bundle.setStatusKey,
              actor: principal,
              runPublicId,
              ...(transitionPreview.requiresAdminOverride && overrideReason
                ? { override: { reason: overrideReason } }
                : {}),
            },
            tx,
          );
          stageCtx = await ordersSvc.stages.contextForRun(lockedOrder.publicId, tx);
          results.push({
            slot: "status",
            outcome: "completed",
            reasonCode: null,
            safeSummary: `Transitioned status from "${applied.fromStatus}" to "${applied.toStatus}".`,
            externalRef: applied.toStatus,
          });
        } catch (err) {
          const reasonCode = err instanceof DomainError ? err.code : "STATUS_TRANSITION_FAILED";
          results.push({
            slot: "status",
            outcome: "failed",
            reasonCode,
            safeSummary:
              err instanceof DomainError
                ? err.message
                : "Order status transition could not be applied.",
            externalRef: bundle.setStatusKey,
          });
        }
      }
    }

    const statusSlotFailed = results.some((r) => r.slot === "status" && r.outcome === "failed");

    // Slot 2: Completion policy
    if (bundle.completion) {
      if (statusSlotFailed) {
        results.push({
          slot: "completion",
          outcome: "skipped",
          reasonCode: "PRIOR_STATUS_SLOT_FAILED",
          safeSummary: "Skipped completion update because the status transition failed.",
          externalRef: null,
        });
      } else {
        try {
          const comp = await admitOrderCompletionInTx(deps, tx, {
            orderId: lockedOrder.id,
            orderPublicId: lockedOrder.publicId,
            workflowVersionId: stageCtx.workflowVersionId,
            stageKey: stage.key,
            expectedRevision: stageCtx.completionRevision,
            policy: bundle.completion,
            sourceKind: "stage_run",
            sourcePublicId: runPublicId,
            idempotencyKey: `stage-run:${runPublicId}:completion`,
            correlationId,
            createdByUserId: principal.userId,
          });
          createdCompletionJobRow = comp.jobRow;
          stageCtx = await ordersSvc.stages.contextForRun(lockedOrder.publicId, tx);

          if (comp.jobRow.delayMinutes > 0) {
            results.push({
              slot: "completion",
              outcome: "scheduled",
              reasonCode: null,
              safeSummary: `Scheduled ${comp.jobRow.resolvedPercent}% completion update in ${comp.jobRow.delayMinutes} min.`,
              externalRef: comp.jobRow.publicId,
            });
          } else if (comp.immediateApplied) {
            results.push({
              slot: "completion",
              outcome: "completed",
              reasonCode: null,
              safeSummary: `Updated completion percentage to ${comp.jobRow.resolvedPercent}%.`,
              externalRef: comp.jobRow.publicId,
            });
          } else {
            results.push({
              slot: "completion",
              outcome: "skipped",
              reasonCode: comp.supersededReasonCode ?? "REVISION_MISMATCH",
              safeSummary: "Completion update was superseded by a concurrent revision.",
              externalRef: comp.jobRow.publicId,
            });
          }
        } catch (err) {
          const reasonCode = err instanceof DomainError ? err.code : "COMPLETION_UPDATE_FAILED";
          results.push({
            slot: "completion",
            outcome: "failed",
            reasonCode,
            safeSummary:
              err instanceof DomainError
                ? err.message
                : "Completion percentage update could not be applied.",
            externalRef: null,
          });
        }
      }
    }

    // Slot 3: Customer email via published phase template
    if (bundle.emailTemplateKey) {
      if (statusSlotFailed) {
        results.push({
          slot: "email",
          outcome: "skipped",
          reasonCode: "PRIOR_STATUS_SLOT_FAILED",
          safeSummary: "Skipped customer email because the status transition failed.",
          externalRef: bundle.emailTemplateKey,
        });
      } else {
        const tpl = deps.services.mailTemplates?.resolveForPhaseAction
          ? await deps.services.mailTemplates.resolveForPhaseAction(bundle.emailTemplateKey, tx)
          : null;
        if (!tpl) {
          results.push({
            slot: "email",
            outcome: "failed",
            reasonCode: "TEMPLATE_UNAVAILABLE",
            safeSummary: `Email template "${bundle.emailTemplateKey}" is not published or incompatible with phase actions.`,
            externalRef: bundle.emailTemplateKey,
          });
        } else if (!lockedOrder.ownerUserId) {
          results.push({
            slot: "email",
            outcome: "skipped",
            reasonCode: "NO_ORDER_CUSTOMER",
            safeSummary: "Order has no customer account to email.",
            externalRef: tpl.key,
          });
        } else {
          const currentStateDef = bound.definition.states.find((s) => s.key === stageCtx.statusKey);
          const allVars: Record<string, string> = {
            reference: lockedOrder.reference,
            phaseLabel: stage.customerLabel,
            statusLabel: currentStateDef?.customerLabel ?? stageCtx.statusKey,
            link: new URL(`/orders/${lockedOrder.publicId}`, deps.config.canonicalOrigin).href,
          };
          const filteredVars: Record<string, string> = {};
          for (const v of tpl.vars) {
            if (v in allVars) {
              filteredVars[v] = allVars[v]!;
            }
          }
          try {
            await deps.mailer.enqueue(
              {
                to: { userId: lockedOrder.ownerUserId },
                template: tpl.key,
                vars: filteredVars,
                idempotencyKey: `stage-run:${runPublicId}:email`,
              },
              tx,
            );
            results.push({
              slot: "email",
              outcome: "completed",
              reasonCode: null,
              safeSummary: `Queued "${tpl.key}" email to order customer.`,
              externalRef: tpl.key,
            });
          } catch (err) {
            results.push({
              slot: "email",
              outcome: "failed",
              reasonCode: err instanceof DomainError ? err.code : "EMAIL_ENQUEUE_FAILED",
              safeSummary: "Customer email could not be queued.",
              externalRef: tpl.key,
            });
          }
        }
      }
    }

    // Slot 4: Workflow webhook
    if (bundle.webhookTargetKey) {
      if (statusSlotFailed) {
        results.push({
          slot: "webhook",
          outcome: "skipped",
          reasonCode: "PRIOR_STATUS_SLOT_FAILED",
          safeSummary: "Skipped workflow webhook because the status transition failed.",
          externalRef: bundle.webhookTargetKey,
        });
      } else if (!deps.services.integrations?.workflowWebhooks?.enqueueStageWebhook) {
        results.push({
          slot: "webhook",
          outcome: "failed",
          reasonCode: "WEBHOOK_PORT_UNAVAILABLE",
          safeSummary: "Workflow webhooks port is unavailable.",
          externalRef: bundle.webhookTargetKey,
        });
      } else {
        const whRes = await deps.services.integrations.workflowWebhooks.enqueueStageWebhook(
          {
            targetKey: bundle.webhookTargetKey,
            orderPublicId: lockedOrder.publicId,
            stageKey: stage.key,
            triggerSource: "stage_bundle",
            idempotencyKey: `stage-run:${runPublicId}:webhook`,
            correlationId,
            actorUserId: principal.userId,
            actorPublicId: liveActor.publicId,
            releaseStatus: stageCtx.statusKey,
            eventKey: "order.stage_bundle.executed",
            payload: {
              order_public_id: lockedOrder.publicId,
              order_reference: lockedOrder.reference,
              stage_key: stage.key,
              stage_label: stage.staffLabel,
              status_key: stageCtx.statusKey,
              stage_run_public_id: runPublicId,
            },
          },
          tx,
        );

        if (whRes.outcome === "queued" || whRes.outcome === "already_queued_or_delivered") {
          results.push({
            slot: "webhook",
            outcome: "completed",
            reasonCode: null,
            safeSummary: whRes.message,
            externalRef:
              whRes.deliveryPublicId ?? whRes.dispatchPublicId ?? bundle.webhookTargetKey,
          });
        } else if (whRes.outcome === "disabled") {
          results.push({
            slot: "webhook",
            outcome: "skipped",
            reasonCode: whRes.reasonCode ?? "WEBHOOK_DISABLED",
            safeSummary: whRes.message,
            externalRef: bundle.webhookTargetKey,
          });
        } else {
          results.push({
            slot: "webhook",
            outcome: "failed",
            reasonCode: whRes.reasonCode ?? "WEBHOOK_REFUSED",
            safeSummary: whRes.message,
            externalRef: bundle.webhookTargetKey,
          });
        }
      }
    }

    // Slot 5: Operational dashboard alert
    if (bundle.dashboardAlert) {
      if (statusSlotFailed) {
        results.push({
          slot: "dashboard_alert",
          outcome: "skipped",
          reasonCode: "PRIOR_STATUS_SLOT_FAILED",
          safeSummary: "Skipped operational alert because the status transition failed.",
          externalRef: null,
        });
      } else if (!deps.services.opsAlerts?.emit) {
        results.push({
          slot: "dashboard_alert",
          outcome: "failed",
          reasonCode: "OPS_ALERTS_UNAVAILABLE",
          safeSummary: "Operational alerts port is unavailable.",
          externalRef: null,
        });
      } else {
        const alertRes = await deps.services.opsAlerts.emit(
          {
            source: "stage_bundle",
            severity: bundle.dashboardAlert.severity,
            dedupKey: `stage_bundle_alert:${lockedOrder.publicId}:${stage.key}:${runPublicId}`,
            correlationId,
            code: "STAGE_BUNDLE_OPERATOR_ALERT",
            title: sanitizeOpsAlertCopy(
              `Phase "${stage.staffLabel}" alert (${lockedOrder.reference})`,
              120,
            ),
            text: sanitizeOpsAlertCopy(bundle.dashboardAlert.text, 500),
            orderPublicId: lockedOrder.publicId,
            runPublicId,
          },
          tx,
        );
        results.push({
          slot: "dashboard_alert",
          outcome: "completed",
          reasonCode: null,
          safeSummary: `Opened ${bundle.dashboardAlert.severity} operational alert.`,
          externalRef: alertRes.publicId,
        });
      }
    }

    const failedSlots = results.filter((r) => r.outcome === "failed");
    const nonFailedActiveSlots = results.filter(
      (r) => r.outcome === "completed" || r.outcome === "scheduled",
    );

    let runState: OrderStageRunState = "completed";
    let runReasonCode: string | null = null;
    if (failedSlots.length > 0) {
      runState = nonFailedActiveSlots.length > 0 ? "partial_failed" : "failed";
      runReasonCode = failedSlots[0]!.reasonCode ?? "STAGE_BUNDLE_FAILED";
    }

    const finishedAt = deps.clock.now();
    const snapshotPayload: PersistedBundleSnapshot = {
      bundle,
      statusOverrideReason:
        bundle.setStatusKey && transitionPreview?.requiresAdminOverride ? overrideReason : null,
    };

    await tx.insert(orderStageRuns).values({
      publicId: runPublicId,
      orderId: lockedOrder.id,
      orderPublicId: lockedOrder.publicId,
      workflowVersionId: stageCtx.workflowVersionId,
      stageKey: stage.key,
      stageLabel: stage.staffLabel,
      triggeredByUserId: principal.userId,
      idempotencyKey,
      correlationId,
      state: runState,
      reasonCode: runReasonCode,
      bundleSnapshotJson: JSON.stringify(snapshotPayload),
      resultsJson: JSON.stringify(results),
      createdAt: startedAt,
      finishedAt,
    });

    const auditEventName =
      runState === "completed"
        ? "order.stage_run.completed"
        : runState === "partial_failed"
          ? "order.stage_run.partial_failed"
          : "order.stage_run.failed";

    await deps.audit.record(
      {
        category: "business",
        eventName: auditEventName,
        action: "execute",
        outcome: runState === "failed" ? "failed" : "completed",
        severity: runState === "completed" ? "INFO" : "ERROR",
        ...(runReasonCode ? { reasonCode: runReasonCode } : {}),
        actor: {
          userId: principal.userId,
          role: principal.role,
        },
        resource: { type: "order_stage_run", publicId: runPublicId },
        orderPublicId: lockedOrder.publicId,
        correlationId,
        safeCounts: {
          total_slots: results.length,
          failed_slots: failedSlots.length,
        },
        attributes: {
          order_public_id: lockedOrder.publicId,
          stage_key: stage.key,
          stage_label: stage.staffLabel,
          stage_run_public_id: runPublicId,
          state: runState,
        },
      },
      tx,
    );

    if ((runState === "partial_failed" || runState === "failed") && deps.services.opsAlerts?.emit) {
      await deps.services.opsAlerts.emit(
        {
          source: "stage_bundle",
          severity: "error",
          dedupKey: `stage_bundle_fail:${runPublicId}`,
          correlationId,
          code: runState === "failed" ? "STAGE_BUNDLE_FAILED" : "STAGE_BUNDLE_PARTIAL_FAILED",
          title: sanitizeOpsAlertCopy(
            `Phase action bundle ${runState === "failed" ? "failed" : "partially failed"} on ${lockedOrder.reference}`,
            120,
          ),
          text: sanitizeOpsAlertCopy(
            failedSlots.map((f) => `${f.slot}: ${f.safeSummary}`).join("; "),
            500,
          ),
          orderPublicId: lockedOrder.publicId,
          runPublicId,
        },
        tx,
      );
    }

    const [insertedRun] = await tx
      .select()
      .from(orderStageRuns)
      .where(eq(orderStageRuns.publicId, runPublicId))
      .limit(1);
    const [stageRunView] = await hydrateStageRunViews(tx, deps.crypto, [insertedRun!]);
    const [completionJobView] = createdCompletionJobRow
      ? await hydrateCompletionJobViews(tx, deps.crypto, [createdCompletionJobRow])
      : [null];

    return {
      deduplicated: false,
      stageRun: stageRunView!,
      completionJob: completionJobView ?? null,
    };
  });
}

export async function listOrderStageBundleRuns(
  deps: ModuleDeps,
  principal: SessionPrincipal,
  input: { orderPublicId: string; stageKey?: string; cursor?: string; limit?: number },
): Promise<{ items: OrderStageRunView[]; nextCursor: string | null }> {
  await assertAutomationsCapabilityPreflight(deps, principal, "orders.automations.run");
  if (!ULID_PATTERN.test(input.orderPublicId)) {
    throw validation("INVALID_ORDER_ID", "Order identifier is invalid.");
  }

  const ordersSvc = deps.services.orders;
  await ordersSvc.assertCanReadOrder(principal, input.orderPublicId);

  const [orderRow] = await deps.db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.publicId, input.orderPublicId))
    .limit(1);
  if (!orderRow) {
    throw notFound("Order not found.");
  }

  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  let cursorId: number | null = null;
  if (input.cursor) {
    const [cur] = await deps.db
      .select({ id: orderStageRuns.id })
      .from(orderStageRuns)
      .where(
        and(
          eq(orderStageRuns.publicId, input.cursor),
          eq(orderStageRuns.orderId, orderRow.id),
        ),
      )
      .limit(1);
    if (cur) cursorId = cur.id;
  }

  const rows = await deps.db
    .select()
    .from(orderStageRuns)
    .where(
      and(
        eq(orderStageRuns.orderId, orderRow.id),
        ...(input.stageKey ? [eq(orderStageRuns.stageKey, input.stageKey)] : []),
        ...(cursorId !== null ? [lt(orderStageRuns.id, cursorId)] : []),
      ),
    )
    .orderBy(desc(orderStageRuns.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = await hydrateStageRunViews(deps.db, deps.crypto, page);
  return {
    items,
    nextCursor: hasMore && page.length > 0 ? page[page.length - 1]!.publicId : null,
  };
}
