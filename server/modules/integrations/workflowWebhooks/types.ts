/**
 * Increment 07 (D7) — Workflow phase webhook selector, validation, stage-bundle/rule dispatch,
 * and opt-in lifecycle auto-queue ports (`services.integrations.workflowWebhooks`).
 */
import type { DbOrTx, SessionPrincipal, Tx } from "../../../core/types.js";
import type { ProductionPhase } from "../production/index.js";

export const WORKFLOW_WEBHOOK_KINDS = ["production", "subscription"] as const;
export type WorkflowWebhookTargetKind = (typeof WORKFLOW_WEBHOOK_KINDS)[number];

export const STAGE_WEBHOOK_TRIGGER_SOURCES = [
  "stage_bundle",
  "lifecycle_payment_confirmed",
  "lifecycle_phase1_locked",
  "automation_rule",
] as const;
export type StageWebhookTriggerSource = (typeof STAGE_WEBHOOK_TRIGGER_SOURCES)[number];

export interface WorkflowWebhookOptionView {
  /** Stable target key (`"production:P101"`..`"production:P401"` or `"subscription:<26-char ULID>"`). */
  targetKey: string;
  kind: WorkflowWebhookTargetKind;
  phase: ProductionPhase | null;
  subscriptionPublicId: string | null;
  /** Safe display label (never contains URLs, hosts, or secrets). */
  label: string;
  configured: boolean;
  enabled: boolean;
  signingEnabled: boolean;
  /** Portable logical reference (`"production:P101"` or subscription name) for workflow export/import. */
  portableRef: string;
}

export interface ListWorkflowWebhookOptionsInput {
  kind?: "all" | WorkflowWebhookTargetKind;
}

export interface WorkflowWebhookValidationResult {
  valid: boolean;
  normalizedKey: string | null;
  kind: WorkflowWebhookTargetKind | null;
  exists: boolean;
  configured: boolean;
  enabled: boolean;
  reasonCode: string | null;
  message: string | null;
  portableRef: string | null;
}

export interface EnqueueStageWebhookInput {
  targetKey: string;
  /** Order public ID (required for `production:P101..P401`; optional for non-order automation triggers). */
  orderPublicId?: string | null;
  stageKey?: string | null;
  triggerSource: StageWebhookTriggerSource;
  /** Deterministic caller idempotency key (`8..120` ASCII chars, e.g. `stage-run:<runPublicId>`). */
  idempotencyKey: string;
  correlationId: string;
  actorUserId?: number | null;
  actorPublicId?: string | null;
  /** Optional P101 `release_status` override; defaults to current order status or `"payment_confirmed"`. */
  releaseStatus?: string | null;
  /** Optional event key for `subscription:<id>` deliveries (defaults to `"order.stage_webhook_triggered"`). */
  eventKey?: string | null;
  /** Optional safe non-PII payload attributes for `subscription:<id>` deliveries (redacted before persistence). */
  payload?: Record<string, unknown>;
}

export type EnqueueStageWebhookOutcome =
  | "queued"
  | "already_queued_or_delivered"
  | "refused_precondition"
  | "disabled";

export interface EnqueueStageWebhookResult {
  outcome: EnqueueStageWebhookOutcome;
  kind: WorkflowWebhookTargetKind | null;
  /** `integration_production_dispatches.public_id` or `integration_webhook_deliveries.public_id` when queued/existing. */
  deliveryPublicId: string | null;
  /** Alias for `deliveryPublicId`. */
  dispatchPublicId: string | null;
  reasonCode: string | null;
  message: string;
}

export interface WorkflowLifecycleAutoQueuePolicy {
  workflowKey: string;
  p101OnPaymentConfirmed: boolean;
  p201OnPhase1Locked: boolean;
  updatedAt: string | null;
}

export interface WorkflowWebhooksService {
  /** Authorized query for phase editor (`workflows.manage`), rule editor (`automations.read`), and bundle runner (`orders.stage.run`). */
  listOptionsForActor(
    principal: SessionPrincipal | null | undefined,
    input?: ListWorkflowWebhookOptionsInput,
  ): Promise<WorkflowWebhookOptionView[]>;

  /** Trusted internal port returning current production + subscription options (no URLs or secrets). */
  listOptions(
    input?: ListWorkflowWebhookOptionsInput,
    tx?: DbOrTx,
  ): Promise<WorkflowWebhookOptionView[]>;

  /** Validates a `webhookTargetKey` at workflow draft save, publish, or rule save. Blank/`null` returns `{ valid: true, normalizedKey: null }`. */
  validateTargetKey(
    targetKey: string | null | undefined,
    tx?: DbOrTx,
  ): Promise<WorkflowWebhookValidationResult>;

  /** Resolves a portable logical reference on workflow import (`"production:P101"` or subscription name). */
  resolvePortableTargetRef(
    portableRef: string | null | undefined,
    tx?: DbOrTx,
  ): Promise<{ targetKey: string | null; warningCode: string | null }>;

  /**
   * Enqueues a stage bundle webhook, automation subscription delivery, or lifecycle auto-queued P101/P201.
   * Refused preconditions (`P101_NOT_DELIVERED`, `PHASE_1_LOCK_REQUIRED`, `PRODUCTION_DISABLED`, `WEBHOOKS_DISABLED`, etc.)
   * are returned as `{ outcome: "refused_precondition" | "disabled", reasonCode }` and NEVER throw to roll back
   * a customer's payment or stage submission.
   */
  enqueueStageWebhook(
    input: EnqueueStageWebhookInput,
    tx?: Tx,
  ): Promise<EnqueueStageWebhookResult>;

  /** Reads per-workflow lifecycle P101/P201 auto-queue switches (all off by default). */
  listLifecycleAutoQueuePolicies(tx?: Tx): Promise<WorkflowLifecycleAutoQueuePolicy[]>;
  getLifecycleAutoQueuePolicy(workflowKey: string, tx?: Tx): Promise<WorkflowLifecycleAutoQueuePolicy>;
  setLifecycleAutoQueuePolicy(
    principal: SessionPrincipal | null | undefined,
    input: {
      workflowKey: string;
      p101OnPaymentConfirmed: boolean;
      p201OnPhase1Locked: boolean;
    },
  ): Promise<WorkflowLifecycleAutoQueuePolicy>;
}
